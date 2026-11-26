'use client';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * One button system (globals.css `.btn`): `primary` is the only filled accent in
 * a view; `outline`/`default` share the secondary look; `ghost` is quiet.
 * `accent` is kept as an alias of `primary` for existing call sites.
 */
type Variant = 'default' | 'ghost' | 'outline' | 'primary' | 'accent' | 'success' | 'danger';

const variants: Record<Variant, string> = {
  default: 'btn--secondary',
  outline: 'btn--secondary',
  ghost: 'btn--ghost',
  primary: 'btn--primary',
  accent: 'btn--primary',
  success: 'btn--success',
  danger: 'btn--danger',
};

export function Button({
  className,
  variant = 'default',
  size = 'md',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }) {
  return <button type={type} className={cn('btn', variants[variant], size === 'sm' && 'btn--sm', className)} {...props} />;
}
