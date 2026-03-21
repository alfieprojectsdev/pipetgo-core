/**
 * 🎓 LEARNING: Textarea Component
 * ===============================
 * Multi-line text input for longer content
 *
 * v0.app UX Enhancement: Added error state support for visual feedback
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Show error styling when true */
  error?: boolean
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, error, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          'flex min-h-[80px] w-full rounded-md border bg-white px-3 py-2',
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
          'resize-y', // Allow vertical resizing only
          className
        )}
        ref={ref}
        aria-invalid={error ? 'true' : undefined}
        {...props}
      />
    )
  }
)

Textarea.displayName = 'Textarea'

export { Textarea }
