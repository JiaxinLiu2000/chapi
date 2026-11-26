import { describe, expect, it } from 'vitest';
import { matchSops, type SopRef } from './match.js';

const SOPS: SopRef[] = [
  { slug: 'tracker-weekly', name: 'UP BD Project Tracker 周更', aliases: ['Project Tracker 更新', 'Tracker 周更', 'UP BD Tracker 更新'] },
  { slug: 'tracker-updates-column', name: 'Tracker Updates 列（投资人双周汇报）', aliases: ['Updates 列', 'Tracker Updates', '投资人双周 Updates'] },
  { slug: 'customer-profiles-weekly', name: 'Customer Profiles 画像表更新', aliases: ['客户画像表更新', '画像表周更', 'Customer Profiles 更新'] },
  { slug: 'attendee-classify', name: 'Attendee List 公司分类', aliases: ['attendee 分类', '活动名单分类'] },
];
const slugs = (t: string) => matchSops(t, SOPS).map((s) => s.slug);

describe('matchSops', () => {
  it('matches the request from the screenshot', () => {
    expect(slugs('更新project tracker')).toEqual(['tracker-weekly']);
  });

  it('is case / spacing insensitive and works with Chinese aliases', () => {
    expect(slugs('帮我把 PROJECT  TRACKER 更新一下')).toEqual(['tracker-weekly']);
    expect(slugs('更新一下客户画像表')).toEqual(['customer-profiles-weekly']);
    expect(slugs('跑一下 attendee 分类')).toEqual(['attendee-classify']);
  });

  it('matches singular / plural and short Chinese phrasings (seen in real use)', () => {
    expect(slugs('更新customer profile')).toEqual(['customer-profiles-weekly']);
    expect(slugs('更新客户画像')).toEqual(['customer-profiles-weekly']);
    expect(slugs('update the project trackers')).toEqual(['tracker-weekly']);
  });

  it('distinguishes the Updates column SOP from the weekly update', () => {
    expect(slugs('写这期的 tracker updates')).toEqual(['tracker-updates-column']);
  });

  it('does not match unrelated requests or a lone generic word', () => {
    expect(slugs('帮我查一下 Greystar 的楼盘')).toEqual([]);
    expect(slugs('更新一下')).toEqual([]);
    expect(slugs('tracker')).toEqual([]);
  });
});
