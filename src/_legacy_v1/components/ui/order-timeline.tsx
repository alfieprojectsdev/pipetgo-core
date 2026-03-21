/**
 * OrderTimeline Component
 *
 * Displays the progression of an order through various states.
 * Shows completed steps with checkmarks, current step with blue indicator,
 * and pending steps with gray indicators.
 */

import { cn, formatDate } from '@/lib/utils'
import { OrderStatus } from '@/types'

export interface OrderTimelineProps {
  status: OrderStatus
  createdAt: string
  quotedAt?: string | null
  acknowledgedAt?: string | null
  completedAt?: string | null
}

interface TimelineStep {
  id: string
  label: string
  date?: string | null
  status: 'completed' | 'current' | 'pending'
}

/**
 * Determines the timeline steps based on order status and dates
 */
function getTimelineSteps(props: OrderTimelineProps): TimelineStep[] {
  const { status, createdAt, quotedAt, acknowledgedAt, completedAt } = props

  // Handle cancelled status specially
  if (status === OrderStatus.CANCELLED) {
    return [
      {
        id: 'submitted',
        label: 'Order Submitted',
        date: createdAt,
        status: 'completed',
      },
      {
        id: 'cancelled',
        label: 'Cancelled',
        date: null,
        status: 'current',
      },
    ]
  }

  // Handle quote rejected status specially
  if (status === OrderStatus.QUOTE_REJECTED) {
    return [
      {
        id: 'submitted',
        label: 'Order Submitted',
        date: createdAt,
        status: 'completed',
      },
      {
        id: 'quote-provided',
        label: 'Quote Provided',
        date: quotedAt,
        status: 'completed',
      },
      {
        id: 'quote-rejected',
        label: 'Quote Declined',
        date: null,
        status: 'current',
      },
    ]
  }

  // Determine step statuses based on current order status
  const statusOrder: OrderStatus[] = [
    OrderStatus.QUOTE_REQUESTED,
    OrderStatus.QUOTE_PROVIDED,
    OrderStatus.PENDING,
    OrderStatus.ACKNOWLEDGED,
    OrderStatus.IN_PROGRESS,
    OrderStatus.COMPLETED,
  ]

  const currentIndex = statusOrder.indexOf(status)

  // Helper to determine step status
  const getStepStatus = (stepIndex: number): 'completed' | 'current' | 'pending' => {
    if (stepIndex < currentIndex) return 'completed'
    if (stepIndex === currentIndex) return 'current'
    return 'pending'
  }

  // Build timeline steps
  const steps: TimelineStep[] = [
    {
      id: 'submitted',
      label: 'Order Submitted',
      date: createdAt,
      status: 'completed', // Always completed once order exists
    },
  ]

  // Quote workflow steps (only show if in quote workflow)
  const quoteWorkflowStatuses: OrderStatus[] = [
    OrderStatus.QUOTE_REQUESTED,
    OrderStatus.QUOTE_PROVIDED,
  ]
  const isInQuoteWorkflow = quoteWorkflowStatuses.includes(status) || Boolean(quotedAt)

  if (isInQuoteWorkflow || status === OrderStatus.QUOTE_REQUESTED) {
    steps.push({
      id: 'awaiting-quote',
      label: 'Awaiting Quote',
      date: null,
      status: status === OrderStatus.QUOTE_REQUESTED ? 'current' : 'completed',
    })
  }

  const postQuoteStatuses: OrderStatus[] = [
    OrderStatus.QUOTE_PROVIDED,
    OrderStatus.PENDING,
    OrderStatus.ACKNOWLEDGED,
    OrderStatus.IN_PROGRESS,
    OrderStatus.COMPLETED,
  ]
  if (quotedAt || postQuoteStatuses.includes(status)) {
    if (isInQuoteWorkflow || quotedAt) {
      steps.push({
        id: 'quote-provided',
        label: 'Quote Provided',
        date: quotedAt,
        status: status === OrderStatus.QUOTE_PROVIDED ? 'current' :
                status === OrderStatus.QUOTE_REQUESTED ? 'pending' : 'completed',
      })
    }
  }

  // Standard workflow steps
  const standardStepIndex = statusOrder.indexOf(OrderStatus.PENDING)

  steps.push({
    id: 'pending',
    label: 'Pending Review',
    date: null,
    status: status === OrderStatus.PENDING ? 'current' :
            currentIndex > standardStepIndex ? 'completed' : 'pending',
  })

  steps.push({
    id: 'acknowledged',
    label: 'Lab Acknowledged',
    date: acknowledgedAt,
    status: status === OrderStatus.ACKNOWLEDGED ? 'current' :
            currentIndex > statusOrder.indexOf(OrderStatus.ACKNOWLEDGED) ? 'completed' : 'pending',
  })

  steps.push({
    id: 'in-progress',
    label: 'Testing in Progress',
    date: null,
    status: status === OrderStatus.IN_PROGRESS ? 'current' :
            currentIndex > statusOrder.indexOf(OrderStatus.IN_PROGRESS) ? 'completed' : 'pending',
  })

  steps.push({
    id: 'completed',
    label: 'Results Available',
    date: completedAt,
    status: status === OrderStatus.COMPLETED ? 'current' : 'pending',
  })

  return steps
}

/**
 * Timeline step indicator component
 */
function StepIndicator({ stepStatus }: { stepStatus: 'completed' | 'current' | 'pending' }) {
  if (stepStatus === 'completed') {
    return (
      <div className="flex h-6 w-6 items-center justify-center rounded-full bg-green-500 text-white">
        <svg
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={3}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>
    )
  }

  if (stepStatus === 'current') {
    return (
      <div className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-blue-500 bg-blue-500">
        <div className="h-2 w-2 rounded-full bg-white" />
      </div>
    )
  }

  // Pending
  return (
    <div className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-gray-300 bg-white">
      <div className="h-2 w-2 rounded-full bg-gray-300" />
    </div>
  )
}

/**
 * OrderTimeline Component
 *
 * Displays visual timeline of order status progression.
 * Shows completed, current, and pending steps with appropriate indicators.
 */
export function OrderTimeline(props: OrderTimelineProps) {
  const steps = getTimelineSteps(props)

  return (
    <ol className="relative" role="list">
      {steps.map((step, index) => {
        const isLast = index === steps.length - 1

        return (
          <li
            key={step.id}
            className={cn(
              'relative flex gap-4 pb-6',
              isLast && 'pb-0'
            )}
            aria-current={step.status === 'current' ? 'step' : undefined}
          >
            {/* Vertical line connector */}
            {!isLast && (
              <div
                className={cn(
                  'absolute left-3 top-6 h-full w-0.5 -translate-x-1/2',
                  step.status === 'completed' ? 'bg-green-500' : 'bg-gray-200'
                )}
                aria-hidden="true"
              />
            )}

            {/* Step indicator */}
            <div className="relative z-10 flex-shrink-0">
              <StepIndicator stepStatus={step.status} />
            </div>

            {/* Step content */}
            <div className="flex flex-col min-w-0 flex-1 pt-0.5">
              <span
                className={cn(
                  'text-sm font-medium',
                  step.status === 'completed' && 'text-green-700',
                  step.status === 'current' && 'text-blue-700',
                  step.status === 'pending' && 'text-gray-500'
                )}
              >
                {step.label}
              </span>
              {step.date && (
                <span className="text-xs text-gray-500 mt-0.5">
                  {formatDate(step.date)}
                </span>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
