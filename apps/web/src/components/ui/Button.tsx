'use client';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

type Variant = 'default' | 'ghost' | 'outline' | 'accent' | 'success' | 'danger';

const variants: Record<Variant, string> = {
  default: 'bg-panel2 hover:bg-border text-text',
  ghost: 'hover:bg-panel2 text-muted hover:text-text',
  outline: 'border border-border bg-panel2/50 text-text hover:border-accent/60 hover:bg-panel2',
  accent: 'bg-accent hover:brightness-110 text-white',
  success: 'bg-success hover:brightness-110 text-white',
  danger: 'bg-danger hover:brightness-110 text-white',
};

export function Button({
  className,
  variant = 'default',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
