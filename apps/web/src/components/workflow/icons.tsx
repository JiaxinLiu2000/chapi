import {
  Calculator,
  ClipboardList,
  FileText,
  GitMerge,
  Globe,
  ListChecks,
  PenLine,
  Phone,
  ScanText,
  Search,
  ShieldCheck,
  Tags,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { WorkflowNodeDef } from '@chapi/shared';
import { BRAND_ICONS, type BrandIconKey } from './brandIcons';

/** Generic stage types → lucide glyphs (used when no app owns the stage). */
const TYPE_ICONS: Record<string, { icon: LucideIcon; title: string }> = {
  prep: { icon: ClipboardList, title: '准备' },
  search: { icon: Search, title: '查找' },
  research: { icon: Globe, title: '网上调研' },
  verify: { icon: ShieldCheck, title: '验证' },
  write: { icon: PenLine, title: '写入' },
  review: { icon: ListChecks, title: '核对' },
  summary: { icon: FileText, title: '交付摘要' },
  classify: { icon: Tags, title: '分类' },
  match: { icon: GitMerge, title: '匹配合并' },
  phone: { icon: Phone, title: '通话' },
  calc: { icon: Calculator, title: '计算' },
  extract: { icon: ScanText, title: '抽取' },
};

/** Keyword → icon, first match wins (stage title first, then its own SOP text). */
const RULES: [RegExp, string][] = [
  [/交付|摘要|提交审批|审批|deliver/i, 'summary'],
  [/apps? script|脚本/i, 'googleappsscript'],
  [/日历|会议|calendar/i, 'googlecalendar'],
  [/邮箱|邮件|gmail|email/i, 'gmail'],
  [/slack/i, 'slack'],
  [/linkedin/i, 'linkedin'],
  [/合同|共享盘|drive|文件夹/i, 'googledrive'],
  [/录音|通话|电话|goto|jive/i, 'phone'],
  [/rocketreach|补挖|biscred|兜底/i, 'search'],
  [/zerobounce|验证|verify/i, 'verify'],
  [/分类|classif/i, 'classify'],
  [/去重|匹配|合并|match/i, 'match'],
  [/核对|对齐|联动|qa|审核/i, 'review'],
  [/抽取|画像/i, 'extract'],
  [/计费|台账|规模|统计/i, 'calc'],
  [/updates 列|写入|tab|tracker|workbook|sheet|表格|重建/i, 'googlesheets'],
  [/准备|备份/i, 'prep'],
  [/调研|官网|websearch/i, 'research'],
];

/** The rule whose keyword appears FIRST in the text wins ("准备：…Jive…" is prep, not a call). */
function earliest(text: string): string | null {
  let best: { at: number; key: string } | null = null;
  for (const [re, key] of RULES) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.at)) best = { at: m.index, key };
  }
  return best?.key ?? null;
}

export function inferIcon(n: Pick<WorkflowNodeDef, 'icon' | 'title' | 'instructions'>): string {
  if (n.icon) return n.icon;
  const own = (n.instructions ?? '').split('【本阶段】\n')[1]?.split('\n\n【')[0] ?? '';
  return earliest(n.title) ?? earliest(own) ?? 'default';
}

export function iconTitle(key: string): string {
  return (BRAND_ICONS as Record<string, { title: string }>)[key]?.title ?? TYPE_ICONS[key]?.title ?? '步骤';
}

/** A stage glyph: brand mark in its own colour, or a neutral type icon. */
export function StageIcon({ iconKey, size = 22, className }: { iconKey: string; size?: number; className?: string }) {
  const brand = (BRAND_ICONS as Record<string, { hex: string; path: string; title: string }>)[iconKey as BrandIconKey];
  if (brand) {
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} className={className} role="img" aria-label={brand.title}>
        <path d={brand.path} fill={brand.hex} />
      </svg>
    );
  }
  const T = TYPE_ICONS[iconKey]?.icon ?? Workflow;
  return <T size={size} className={className} role="img" aria-label={iconTitle(iconKey)} />;
}
