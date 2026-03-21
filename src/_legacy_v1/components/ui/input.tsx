/**
 * 🎓 LEARNING: Input Component
 * ===========================
 * Base text input with consistent styling across the application.
 * This follows the shadcn/ui pattern with forwardRef for form library compatibility.
 *
 * v0.app UX Enhancement: Added error state support for visual feedback
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Show error styling when true */
  error?: boolean
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, error, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          // Base styles
          'flex h-10 w-full rounded-md border bg-white px-3 py-2',
          // Text styles
          'text-sm placeholder:text-gray-400',
          // Default border
          'border-gray-300',
          // Focus styles - blue ring
          'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent',
          // Error styles - red border and ring
          error && 'border-red-500 focus:ring-red-500',
          // Disabled styles
          'disabled:cursor-not-allowed disabled:opacity-50',
          // Transition for smooth state changes
          'transition-colors duration-150',
          // Custom className
          className
        )}
        ref={ref}
        aria-invalid={error ? 'true' : undefined}
        {...props}
      />
    )
  }
)

Input.displayName = 'Input'

export { Input }
