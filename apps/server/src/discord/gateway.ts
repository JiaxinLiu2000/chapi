/**
 * discord.js adapter for the Discord remote: owns the bot connection, finds the
 * owner (the Discord application's owner / team — only they may drive chapi),
 * and translates between Discord objects and the transport-neutral DiscordBridge.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  Partials,
  PermissionsBitField,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  ThreadAutoArchiveDuration,
  Team,
  type Interaction,
  type Message,
} from 'discord.js';
import path from 'node:path';
import type { DiscordStatusDTO } from '@chapi/shared';
import { prisma } from '../db/client.js';
import { createLogger } from '../logger.js';
import { settings } from '../secrets.js';
import { DiscordBridge, type Btn, type DiscordPort, type OutPayload } from './bridge.js';

const log = createLogger('discord:gateway');

const BOT_PERMISSIONS = PermissionsBitField.resolve([
  PermissionsBitField.Flags.ViewChannel,
  PermissionsBitField.Flags.SendMessages,
  PermissionsBitField.Flags.SendMessagesInThreads,
  PermissionsBitField.Flags.CreatePublicThreads,
  PermissionsBitField.Flags.ManageThreads,
  PermissionsBitField.Flags.ReadMessageHistory,
  PermissionsBitField.Flags.EmbedLinks,
  PermissionsBitField.Flags.AttachFiles,
  PermissionsBitField.Flags.AddReactions,
]);

const STYLE: Record<Btn['style'], ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

/** Dropdown rows first, then button rows — Discord allows 5 rows per message. */
function toRows(p: OutPayload) {
  const selects = (p.selects ?? []).slice(0, 5).map((s) =>
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(s.id)
        .setPlaceholder(s.placeholder.slice(0, 150))
        .addOptions(
          s.options.slice(0, 25).map((o) => ({
            label: o.label.slice(0, 100),
            value: o.value,
            default: Boolean(o.default),
            ...(o.description ? { description: o.description.slice(0, 100) } : {}),
          })),
        ),
    ),
  );
  const buttons = (p.buttons ?? [])
    .filter((r) => r.length)
    .map((r) =>
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        r.slice(0, 5).map((b) => new ButtonBuilder().setCustomId(b.id).setLabel(b.label.slice(0, 80)).setStyle(STYLE[b.style]).setDisabled(Boolean(b.disabled))),
      ),
    );
  return [...selects, ...buttons].slice(0, 5);
}

function explain(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/disallowed intents/i.test(msg)) return '机器人没开 MESSAGE CONTENT INTENT：Developer Portal → Bot → Privileged Gateway Intents 里打开它，再点保存';
  if (/invalid token|TokenInvalid/i.test(msg)) return 'Bot Token 不对：去 Developer Portal → Bot → Reset Token 复制新的';
  return msg;
}

export class DiscordGateway implements DiscordPort {
  private client: Client | null = null;
  private connected = false;
  private lastError: string | null = null;
  private ownerIds: string[] = [];
  private ownerNames: string[] = [];
  private guildId: string | null = null;
  private channelId: string | null = null;

  constructor(readonly bridge: DiscordBridge) {}

  async start(): Promise<void> {
    const { token, channelId } = await settings.getDiscord();
    this.channelId = channelId ?? null;
    if (token) await this.connect(token).catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.bridge.detach();
    this.connected = false;
    const c = this.client;
    this.client = null;
    await c?.destroy().catch(() => undefined);
  }

  private async connect(token: string): Promise<void> {
    await this.stop();
    this.lastError = null;
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
      partials: [Partials.Channel],
    });
    this.client = client;

    client.once(Events.ClientReady, (c) => void this.onReady(c).catch((err) => (this.lastError = explain(err))));
    client.on(Events.MessageCreate, (m) => void this.onMessage(m).catch((err) => log.warn('message handling failed', err)));
    client.on(Events.InteractionCreate, (i) => void this.onInteraction(i).catch((err) => log.warn('interaction failed', err)));
    client.on(Events.Error, (err) => {
      this.lastError = explain(err);
      log.warn('discord client error', err);
    });
    client.on(Events.ShardDisconnect, () => (this.connected = false));
    client.on(Events.ShardResume, () => (this.connected = true));

    try {
      await client.login(token);
    } catch (err) {
      this.lastError = explain(err);
      this.client = null;
      await client.destroy().catch(() => undefined);
      throw err;
    }
  }

  private async onReady(c: Client<true>): Promise<void> {
    const app = await c.application.fetch();
    const owner = app.owner;
    if (owner instanceof Team) {
      this.ownerIds = [...owner.members.keys()];
      this.ownerNames = owner.members.map((m) => m.user.username);
    } else if (owner) {
      this.ownerIds = [owner.id];
      this.ownerNames = [owner.username];
    }
    await this.resolveGuild();
    await this.bridge.attach(this, this.ownerIds, this.channelId);
    this.connected = true;
    log.info(`Discord bot ${c.user.tag} ready (owners: ${this.ownerNames.join(', ') || 'unknown'})`);
  }

  private async resolveGuild(): Promise<void> {
    this.guildId = null;
    if (!this.client || !this.channelId) return;
    const ch = await this.client.channels.fetch(this.channelId).catch(() => null);
    if (ch && 'guildId' in ch) this.guildId = ch.guildId;
  }

  async configure(input: { token?: string | null; channelId?: string | null }): Promise<void> {
    await settings.setDiscord(input);
    if (input.channelId !== undefined) {
      this.channelId = input.channelId || null;
      this.bridge.setHomeChannel(this.channelId);
      await this.resolveGuild();
    }
    if (input.token === null || input.token === '') {
      await this.stop();
      this.lastError = null;
    } else if (input.token) {
      await this.connect(input.token).catch(() => undefined);
    }
  }

  async status(): Promise<DiscordStatusDTO> {
    const { token } = await settings.getDiscord();
    const c = this.client?.isReady() ? this.client : null;
    const channels = c
      ? c.guilds.cache.flatMap((g) =>
          g.channels.cache
            .filter((ch) => ch.type === ChannelType.GuildText)
            .filter((ch) => Boolean(ch.permissionsFor(c.user)?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.CreatePublicThreads]))),
        ).map((ch) => ({ id: ch.id, name: ch.name, guild: ch.guild.name }))
      : [];
    const bindings = this.bridge.bindingList();
    const sessions = bindings.length
      ? await prisma.session.findMany({ where: { id: { in: bindings.map((b) => b.sessionId) } }, select: { id: true, title: true, slug: true } })
      : [];
    const byId = new Map(sessions.map((s) => [s.id, s]));
    return {
      configured: Boolean(token),
      connected: Boolean(c && this.connected),
      botTag: c?.user.tag ?? null,
      inviteUrl: c ? `https://discord.com/oauth2/authorize?client_id=${c.application.id}&scope=bot&permissions=${BOT_PERMISSIONS}` : null,
      owners: this.ownerNames,
      channelId: this.channelId,
      channels,
      lastError: this.lastError,
      prefs: await settings.getDiscordPrefs(),
      bindings: bindings
        .filter((b) => byId.has(b.sessionId))
        .map((b) => ({ ...b, slug: byId.get(b.sessionId)!.slug, title: byId.get(b.sessionId)!.title })),
    };
  }

  // ── Discord → bridge ─────────────────────────────────────────────────────

  private async onMessage(m: Message): Promise<void> {
    if (m.author.bot || !this.client) return;
    const ch = m.channel;
    await this.bridge.onMessage({
      channelId: ch.id,
      parentId: ch.isThread() ? ch.parentId : null,
      isDM: ch.isDMBased(),
      authorId: m.author.id,
      messageId: m.id,
      content: m.content,
      attachments: [...m.attachments.values()].map((a) => ({ url: a.url, name: a.name, size: a.size, contentType: a.contentType })),
    });
  }

  private async onInteraction(i: Interaction): Promise<void> {
    if (i.isButton()) {
      const modal = this.bridge.isOwner(i.user.id) ? this.bridge.modalFor(i.customId) : null;
      if (modal) {
        // Must be the first response to the click — no deferral before a modal.
        await i.showModal(
          new ModalBuilder()
            .setCustomId(modal.id)
            .setTitle(modal.title)
            .addComponents(
              new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder().setCustomId('text').setLabel(modal.label).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(2000),
              ),
            ),
        );
        return;
      }
      await i.deferUpdate();
      const note = await this.bridge.onButton(i.customId, i.user.id, i.channelId, i.message.id);
      if (note) await i.followUp({ content: note, flags: MessageFlags.Ephemeral }).catch(() => undefined);
      return;
    }
    if (i.isStringSelectMenu()) {
      await i.deferUpdate();
      const note = await this.bridge.onSelect(i.customId, i.user.id, i.values[0] ?? '', i.channelId, i.message.id);
      if (note) await i.followUp({ content: note, flags: MessageFlags.Ephemeral }).catch(() => undefined);
      return;
    }
    if (i.isModalSubmit()) {
      if (i.isFromMessage()) await i.deferUpdate();
      else await i.deferReply({ flags: MessageFlags.Ephemeral });
      const note = await this.bridge.onModal(i.customId, i.user.id, i.fields.getTextInputValue('text'));
      if (note) await i.followUp({ content: note, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
  }

  // ── DiscordPort ──────────────────────────────────────────────────────────

  private async sendable(channelId: string) {
    if (!this.client) throw new Error('Discord 未连接');
    const ch = await this.client.channels.fetch(channelId);
    if (!ch || !ch.isSendable()) throw new Error(`channel ${channelId} is not sendable`);
    return ch;
  }

  async send(channelId: string, p: OutPayload): Promise<string> {
    const ch = await this.sendable(channelId);
    const msg = await ch.send({
      content: p.content || undefined,
      components: toRows(p),
      files: (p.files ?? []).map((f) => ({ attachment: f, name: path.basename(f) })),
    });
    return msg.id;
  }

  async edit(channelId: string, messageId: string, p: OutPayload): Promise<void> {
    const ch = await this.sendable(channelId);
    const msg = await ch.messages.fetch(messageId);
    await msg.edit({ content: p.content, components: toRows(p) });
  }

  async typing(channelId: string): Promise<void> {
    await (await this.sendable(channelId)).sendTyping();
  }

  async createThread(parentChannelId: string, name: string, firstMessage: string): Promise<string> {
    if (!this.client) throw new Error('Discord 未连接');
    const parent = await this.client.channels.fetch(parentChannelId);
    if (!parent || parent.type !== ChannelType.GuildText) throw new Error('所选频道不是文字频道');
    const thread = await parent.threads.create({ name, autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek, type: ChannelType.PublicThread });
    await thread.send(firstMessage);
    return thread.id;
  }

  async setArchived(threadId: string, archived: boolean): Promise<void> {
    if (!this.client) return;
    const ch = await this.client.channels.fetch(threadId).catch(() => null);
    if (ch?.isThread() && ch.archived !== archived) await ch.setArchived(archived);
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    if (!this.client) return;
    const ch = await this.client.channels.fetch(threadId).catch(() => null);
    if (ch?.isThread() && ch.name !== name) await ch.setName(name);
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    const ch = await this.sendable(channelId);
    await (await ch.messages.fetch(messageId)).react(emoji);
  }

  threadUrl(threadId: string): string | null {
    return this.guildId ? `https://discord.com/channels/${this.guildId}/${threadId}` : null;
  }
}

export const discordBridge = new DiscordBridge();
export const discordGateway = new DiscordGateway(discordBridge);
