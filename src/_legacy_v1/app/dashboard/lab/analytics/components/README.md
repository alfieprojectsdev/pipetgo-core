# Analytics Components

## QuoteMetrics

Displays key performance indicators for quote management with 4 metric cards showing total quotes, acceptance rate, average quote price, and pending quotes.

### Usage

```tsx
import { QuoteMetrics } from './components/QuoteMetrics'

export default async function AnalyticsPage() {
  // Fetch analytics data from API
  const response = await fetch('/api/analytics?timeframe=last30days')
  const data = await response.json()

  return (
    <div className="space-y-6">
      <QuoteMetrics data={data.quotes} />
    </div>
  )
}
```

### Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `data.totalQuotes` | `number` | Yes | Total number of quotes provided to clients |
| `data.acceptedQuotes` | `number` | Yes | Number of quotes that led to orders |
| `data.acceptanceRate` | `number` | Yes | Percentage (0-100) of quotes accepted |
| `data.avgQuotePrice` | `number` | Yes | Average price of accepted quotes |
| `data.pendingQuotes` | `number` | Yes | Number of quotes awaiting client approval |
| `loading` | `boolean` | No | Shows loading skeleton when true |

### Data Format

```typescript
const exampleData = {
  totalQuotes: 50,
  acceptedQuotes: 40,
  acceptanceRate: 80,
  avgQuotePrice: 15000,
  pendingQuotes: 5
}
```

### Visual Design

**Grid Layout:**
- Desktop (≥1024px): 4 columns
- Tablet (≥768px): 2 columns
- Mobile (<768px): 1 column
- Gap: 4px between cards

**Card 1: Total Quotes**
- Icon: FileText (gray)
- Value: Total number
- Description: "All quotes provided to clients"

**Card 2: Acceptance Rate**
- Icon: Conditional based on performance
  - ≥75%: TrendingUp (green) + "Excellent" badge (green)
  - 50-74%: CheckCircle (yellow) + "Good" badge (yellow)
  - <50%: TrendingDown (red) + "Needs Work" badge (red)
- Value: Percentage with 1 decimal
- Description: "X of Y quotes accepted"

**Card 3: Average Quote Price**
- Icon: DollarSign (gray)
- Value: Formatted currency (₱X,XXX.XX)
- Description: "Based on accepted quotes"

**Card 4: Pending Quotes**
- Icon: Clock (gray)
- Value: Number of pending quotes
- Badge: Percentage of total (when > 0)
- Description: "Awaiting client approval"

### States

1. **Loading**: Shows 4 skeleton cards with animated pulse
2. **Empty**: Shows single card with "No quotes yet" message and guidance
3. **Normal**: Displays 4 metric cards with real data

### Color Coding

Acceptance rate performance indicators:
- **Excellent (≥75%)**: Green icon, green badge
- **Good (50-74%)**: Yellow icon, yellow badge
- **Needs Work (<50%)**: Red icon, red badge

### Example Screenshots

**Excellent Performance (80% acceptance)**:
```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│ Total Quotes │ Accept Rate  │ Avg Price    │ Pending      │
│ 50           │ 80.0% ↗️     │ ₱15,000.00   │ 5            │
│              │ Excellent ✅ │              │ 10% of total │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

**Needs Work (30% acceptance)**:
```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│ Total Quotes │ Accept Rate  │ Avg Price    │ Pending      │
│ 20           │ 30.0% ↘️     │ ₱18,000.00   │ 10           │
│              │ Needs Work ⚠│              │ 50% of total │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

### Integration with Analytics API

This component expects data from `/api/analytics`:

```typescript
// Expected API response format
{
  quotes: {
    totalQuotes: 50,
    acceptedQuotes: 40,
    acceptanceRate: 80,
    avgQuotePrice: 15000,
    pendingQuotes: 5
  }
}
```

### Accessibility

- All icons have aria-labels via lucide-react
- Color coding supplemented with text badges
- High contrast between text and backgrounds
- Responsive design ensures readability on all devices
- Loading states clearly communicate async operations

### Performance Insights

Lab admins can use these metrics to:
- **Monitor quote success**: Track acceptance rate trends
- **Optimize pricing**: Compare average prices to acceptance rates
- **Follow up promptly**: See pending quotes awaiting response
- **Identify issues**: Red "Needs Work" badge signals pricing problems

---

## RevenueChart

Displays monthly revenue trends with dual-axis line chart for lab analytics dashboard.

### Usage

```tsx
import { RevenueChart } from './components/RevenueChart'

export default async function AnalyticsPage() {
  // Fetch analytics data from API
  const response = await fetch('/api/analytics?timeframe=last30days')
  const data = await response.json()

  return (
    <div className="space-y-6">
      <RevenueChart data={data.revenue.monthlyBreakdown} />
    </div>
  )
}
```

### Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `data` | `Array<{ month: string, revenue: number, orderCount: number }>` | Yes | Monthly revenue data |
| `loading` | `boolean` | No | Shows loading state when true |

### Data Format

```typescript
const exampleData = [
  { month: "2024-01", revenue: 125000, orderCount: 15 },
  { month: "2024-02", revenue: 145000, orderCount: 18 },
  { month: "2024-03", revenue: 167000, orderCount: 22 }
]
```

### Visual Design

- **Green line**: Revenue (₱) - left Y-axis
- **Blue line**: Order count - right Y-axis
- **Tooltip**: Shows both metrics on hover
- **Legend**: Bottom of chart
- **Responsive**: 100% width, 320px height

### States

1. **Loading**: Shows "Loading chart data..." message
2. **Empty**: Shows "No completed orders yet" when data is empty
3. **Normal**: Displays line chart with data

### Example Screenshots

**With Data**: Line chart showing revenue trends over 6 months
**Loading State**: Gray loading message centered in card
**Empty State**: Helpful message guiding users

### Integration with Analytics API

This component expects data from `/api/analytics`:

```typescript
// Expected API response format
{
  revenue: {
    monthlyBreakdown: [
      { month: "2024-01", revenue: 125000, orderCount: 15 },
      // ...
    ]
  }
}
```

### Accessibility

- Chart uses semantic color scheme (green for revenue, blue for count)
- Tooltip provides detailed information on hover
- Loading and empty states have clear text descriptions
- Responsive design works on mobile and desktop
