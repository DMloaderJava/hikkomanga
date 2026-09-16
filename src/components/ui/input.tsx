import * as React from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

/** Типы, где подсказки браузера мешают: логины, пароли, URL, поиск. */
const ASSIST_OFF_TYPES = new Set(['email', 'password', 'url', 'search', 'tel']);

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    // Для обычного текста (названия, авторы) автокапитализацию НЕ трогаем —
    // иначе на мобильных ломается ввод на русском.
    const assistOff = ASSIST_OFF_TYPES.has(type ?? 'text');

    return (
      <input
        type={type}
        // Тёмный фон автозаполнения красят правила :-webkit-autofill
        // в styles/globals.css — здесь только подсказки клавиатуры.
        autoCapitalize={assistOff ? 'off' : undefined}
        autoCorrect={assistOff ? 'off' : undefined}
        spellCheck={assistOff ? false : undefined}
        className={cn(
          'flex h-10 w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:border-transparent disabled:cursor-not-allowed disabled:opacity-50 transition-colors',
          className
        )}
        ref={ref}
        // {...props} идёт последним — вызывающий код может переопределить
        // любой из атрибутов выше точечно.
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';

export { Input };
