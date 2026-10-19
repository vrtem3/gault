/** Кнопка shadcn/ui (MIT), настроенная на семантические токены Gault. */
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

const buttonVariants = cva('button', { variants: { variant: { default: 'button-primary', secondary: 'button-secondary', ghost: 'button-ghost', danger: 'button-danger' }, size: { default: '', icon: 'button-icon' } }, defaultVariants: { variant: 'default', size: 'default' } });
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants> & { asChild?: boolean };

/** Принимает ButtonProps; возвращает доступную кнопку или Slot с общими состояниями. */
export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Component = asChild ? Slot : 'button';
  return <Component className={twMerge(clsx(buttonVariants({ variant, size }), className))} {...props} />;
}
