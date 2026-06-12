import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  WS_PATH,
  encodeServerEvent,
  parseClientCommand,
  type ServerEvent,
} from '@chapi/shared';
import { createLogger } from '../logger.js';
import { getOrchestrator } from '../orchestrator/types.js';
import { browserView } from '../engine/browserView.js';
import { bus, isGlobalEvent } from './bus.js';

const log = createLogger('ws');

/** Pull the owning sessionId out of any ServerEvent (or null for global). */
function eventSessionId(event: ServerEvent): string | null {
  if (event.type === 'session.created' || event.type === 'session.updated') {
    return event.session.id;
  }
  if ('sessionId' in event) return event.sessionId;
  return null;
}

export function attachWebSocket(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server, path: WS_PATH });

  wss.on('connection', (socket: WebSocket) => {
    const subscribed = new Set<string>();
    const viewing = new Set<string>(); // sessions whose browser screencast this socket watches
    log.debug('client connected');

    const send = (event: ServerEvent) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(encodeServerEvent(event));
      }
    };

    // Forward bus events this connection cares about.
    const off = bus.on((event) => {
      const sid = eventSessionId(event);
      if (isGlobalEvent(event) || (sid && subscribed.has(sid))) send(event);
    });

    socket.on('message', async (raw) => {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw.toString());
      } catch {
        return send({ type: 'error', sessionId: null, message: 'invalid JSON' });
      }
      const result = parseClientCommand(parsedJson);
      if (!result.ok) {
        return send({ type: 'error', sessionId: null, message: result.error });
      }
      const cmd = result.command;
      try {
        switch (cmd.type) {
          case 'ping':
            return;
          case 'session.subscribe':
            subscribed.add(cmd.sessionId);
            return;
          case 'session.unsubscribe':
            subscribed.delete(cmd.sessionId);
            return;
          case 'user.message':
            await getOrchestrator().handleUserMessage(
              cmd.sessionId,
              cmd.text,
              cmd.attachmentIds,
            );
            return;
          case 'interrupt':
            await getOrchestrator().interrupt(cmd.sessionId);
            return;
          case 'answer.question':
            await getOrchestrator().answerQuestion(
              cmd.sessionId,
              cmd.questionId,
              cmd.answer,
            );
            return;
          case 'approval.decision':
            await getOrchestrator().decideApproval(
              cmd.sessionId,
              cmd.approvalId,
              cmd.decision,
              cmd.feedback,
            );
            return;
          case 'mark.completed':
            await getOrchestrator().markCompleted(cmd.sessionId);
            return;
          case 'set.config':
            await getOrchestrator().setConfig(
              cmd.sessionId,
              cmd.model,
              cmd.effort,
              cmd.subagentModel,
            );
            return;
          case 'browser.view':
            if (cmd.on) {
              viewing.add(cmd.sessionId);
              await browserView.addViewer(cmd.sessionId);
            } else {
              viewing.delete(cmd.sessionId);
              browserView.removeViewer(cmd.sessionId);
            }
            return;
        }
      } catch (err) {
        log.error(`command ${cmd.type} failed`, err);
        const sid = 'sessionId' in cmd ? cmd.sessionId : null;
        send({
          type: 'error',
          sessionId: sid,
          message: err instanceof Error ? err.message : 'command failed',
        });
      }
    });

    socket.on('close', () => {
      off();
      for (const sid of viewing) browserView.removeViewer(sid);
      viewing.clear();
      log.debug('client disconnected');
    });
    socket.on('error', (err) => log.warn('socket error', err));
  });

  log.info(`WebSocket listening on ${WS_PATH}`);
  return wss;
}
