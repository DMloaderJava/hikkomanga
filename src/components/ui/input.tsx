import * as React from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        // Keeps mobile keyboards / browsers from decorating the field with
        // capitalisation and spelling hints. The dark autofill fill itself is
        // handled by the `:-webkit-autofill` rules in styles/globals.css, which
        // paint `--input-bg` over the browser's light yellow/blue background.
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className={cn(
          'flex h-10 w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:border-transparent disabled:cursor-not-allowed disabled:opacity-50 transition-colors',
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';

export { Input };
