'use client';
import { useCallback, useState } from 'react';
import { Button } from './Button';
import { Modal } from './Modal';

/**
 * Closing a form with unsaved edits asks first. Use `requestClose` for every way
 * out (the Modal's onClose — Esc, scrim, ✕ — and the form's own 取消), and render
 * `confirm` next to the form's Modal (it stacks on top; Esc closes only it).
 */
export function useDiscardGuard(dirty: boolean, close: () => void) {
  const [asking, setAsking] = useState(false);
  const requestClose = useCallback(() => (dirty ? setAsking(true) : close()), [dirty, close]);
  const confirm = (
    <Modal
      open={asking}
      onClose={() => setAsking(false)}
      title="放弃未保存的修改？"
      className="sm:max-w-sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => setAsking(false)}>
            继续编辑
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setAsking(false);
              close();
            }}
          >
            放弃修改
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-muted">关闭后，这次填写但还没保存的内容会丢失。</p>
    </Modal>
  );
  return { requestClose, confirm };
}
