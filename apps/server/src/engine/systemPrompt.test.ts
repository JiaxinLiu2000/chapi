import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from './systemPrompt.js';

describe('buildSystemPrompt: automation tools', () => {
  it('describes the automation tools, tiers and the no-files/no-DB rule next to the SOP catalogue', () => {
    const p = buildSystemPrompt('s1', 'web', null, 3, 'zh', null);
    const sop = p.indexOf('## 工作流（已确认的 SOP）');
    const board = p.indexOf('## 自动化面板');
    expect(sop).toBeGreaterThan(-1);
    expect(board).toBeGreaterThan(sop);
    for (const t of ['automation_list', 'automation_upsert', 'automation_link_history', 'automation_set_mode', 'automation_delete', 'automation_run_now']) {
      expect(p).toContain(t);
    }
    expect(p).toContain('确认卡片');
    expect(p).toContain('不要改文件或数据库');
  });
});
