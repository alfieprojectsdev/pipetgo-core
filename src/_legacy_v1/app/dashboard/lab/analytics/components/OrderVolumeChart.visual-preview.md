# OrderVolumeChart Visual Preview

## Chart Layout

```
┌────────────────────────────────────────────────────────────────────────┐
│ Order Volume                                                           │
│ Total: 125 orders | Average: 10.4 orders/month | Peak: Mar 2024 (22)  │
│ ────────────────────────────────────────────────────────────────────── │
│                                                                        │
│   22  ██████████████████████████████  ← Peak month (GREEN)            │
│   20                                                                   │
│   18      ████████████████████                                        │
│   16                                                                   │
│   14                          ██████████████                          │
│   12  ████████                                    ████████            │
│   10          ██████                      ██████          ██████      │
│    8                                                              ████│
│    6                  ████      ████                                  │
│    4                                                                   │
│    2                                                                   │
│    0                                                                   │
│     ───────────────────────────────────────────────────────────────   │
│     Jan  Feb  Mar  Apr  May  Jun  Jul  Aug  Sep  Oct  Nov  Dec       │
│     2024 2024 2024 2024 2024 2024 2024 2024 2024 2024 2024 2024       │
│                                                                        │
│     Legend: ▬ Orders (blue bars, green for peak)                      │
└────────────────────────────────────────────────────────────────────────┘
```

## Color Coding

### Standard Months (Blue #3b82f6)
```
  12  ████████  ← Standard blue bar
  10
   8
   6
   4
   2
   0
      Jan 2024
```

### Peak Month (Green #10b981)
```
  22  ██████████████████████████████  ← Highlighted in green
  20
  18
  16
  14
  12
  10
   8
   6
   4
   2
   0
      Mar 2024 (Peak: 22 orders)
```

## Hover Tooltip

```
┌─────────────────────┐
│ Mar 2024            │  ← Month label (font-semibold)
│                     │
│ ● Orders: 22        │  ← Blue circle indicator + count
└─────────────────────┘
    ↑ Appears on bar hover with white background, border, shadow
```

## Card Description Statistics

**Formula:**
- **Total**: Sum of all orderCount values
- **Average**: Total ÷ number of months (1 decimal place)
- **Peak**: Month with highest orderCount

**Examples:**
```
Total: 125 orders | Average: 10.4 orders/month | Peak: Mar 2024 (22 orders)
Total: 45 orders | Average: 7.5 orders/month | Peak: Jun 2024 (15 orders)
Total: 8 orders | Average: 4.0 orders/month | Peak: Feb 2024 (5 orders)
```

## Loading State

```
┌────────────────────────────────────────────────────────────────────────┐
│ Order Volume                                                           │
│ Monthly order trends                                                   │
│ ────────────────────────────────────────────────────────────────────── │
│                                                                        │
│                                                                        │
│                     Loading chart data...                              │
│                                                                        │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

## Empty State

```
┌────────────────────────────────────────────────────────────────────────┐
│ Order Volume                                                           │
│ No order data available                                                │
│ ────────────────────────────────────────────────────────────────────── │
│                                                                        │
│                                                                        │
│                        No orders yet                                   │
│                                                                        │
│           Order volume data will appear once                           │
│           clients start placing orders                                 │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

## Real Data Scenarios

### Scenario 1: New Lab (Growing)
```
Data: [
  { month: "2024-01", orderCount: 2 },
  { month: "2024-02", orderCount: 5 },
  { month: "2024-03", orderCount: 8 },
  { month: "2024-04", orderCount: 12 }
]

Total: 27 orders | Average: 6.8 orders/month | Peak: Apr 2024 (12 orders)

  12  ████████████████████████████████  ← GREEN (peak)
  10
   8          ████████████████
   6
   4      ████████
   2  ████
   0
     Jan  Feb  Mar  Apr
     2024 2024 2024 2024

💡 Insight: Steady upward trend - lab is gaining clients
```

### Scenario 2: Established Lab (Stable)
```
Data: [
  { month: "2024-01", orderCount: 18 },
  { month: "2024-02", orderCount: 22 },
  { month: "2024-03", orderCount: 19 },
  { month: "2024-04", orderCount: 21 },
  { month: "2024-05", orderCount: 20 },
  { month: "2024-06", orderCount: 23 }
]

Total: 123 orders | Average: 20.5 orders/month | Peak: Jun 2024 (23 orders)

  23      ████████████████████████████████  ← GREEN (peak)
  22  ████████████████████████████
  21              ████████████████████████
  20                      ████████████████████
  19          ████████████████████
  18  ████████████████████
  17
  16
  15
     Jan  Feb  Mar  Apr  May  Jun
     2024 2024 2024 2024 2024 2024

💡 Insight: Consistent high volume - lab has stable client base
```

### Scenario 3: Seasonal Lab (Peaks and Valleys)
```
Data: [
  { month: "2024-01", orderCount: 5 },
  { month: "2024-02", orderCount: 8 },
  { month: "2024-03", orderCount: 22 },  ← Tax season
  { month: "2024-04", orderCount: 18 },
  { month: "2024-05", orderCount: 6 },
  { month: "2024-06", orderCount: 9 }
]

Total: 68 orders | Average: 11.3 orders/month | Peak: Mar 2024 (22 orders)

  22          ██████████████████████████████  ← GREEN (peak)
  20
  18                  ████████████████████████
  16
  14
  12
  10                              ████████
   8      ████████
   6  ████                    ████████
   4
   2
   0
     Jan  Feb  Mar  Apr  May  Jun
     2024 2024 2024 2024 2024 2024

💡 Insight: Peak in Mar/Apr suggests seasonal demand (e.g., fiscal year testing)
```

## Chart Features

### Bar Design
- **Width**: Auto-sized by Recharts based on container width
- **Radius**: [8, 8, 0, 0] - Rounded top corners for modern look
- **Color**: #3b82f6 (blue) for standard, #10b981 (green) for peak
- **Spacing**: Automatic spacing between bars

### Axes
- **X-Axis**:
  - Angled labels (-45°) for readability
  - Month format: "Jan 2024", "Feb 2024", etc.
  - Height: 80px to accommodate angled text
- **Y-Axis**:
  - Integer values only (allowDecimals: false)
  - Auto-scaled based on data range
  - Font size: 12px

### Grid
- **Style**: Dashed lines (strokeDasharray: "3 3")
- **Color**: #e0e0e0 (light gray)
- **Purpose**: Helps read values from bars

### Responsive Container
- **Width**: 100% (fills card width)
- **Height**: 320px (fixed height for consistency)
- **Margins**: { top: 5, right: 30, left: 20, bottom: 5 }

## Use Cases

### Capacity Planning
Lab admin sees peak months and can:
- Schedule staff accordingly
- Order supplies in advance
- Plan equipment maintenance during slow periods

### Growth Tracking
Lab admin identifies trends:
- Upward trend = marketing working
- Downward trend = investigate client churn
- Flat trend = stable but may need growth initiatives

### Seasonal Insights
Lab admin discovers patterns:
- Q1 peak = tax-related testing
- Summer dip = client vacation periods
- Year-end spike = fiscal year compliance

## Component Behavior

### Data Requirements
- Minimum 1 month of data to display
- Data sorted chronologically (handled by API)
- Month format: "YYYY-MM" (e.g., "2024-01")

### Peak Detection
- Single peak month highlighted in green
- If multiple months tie for peak, first one highlighted
- Peak value shown in card description

### Responsive Design
- Chart maintains 320px height on all screen sizes
- X-axis labels auto-adjust angle for readability
- Bar width adapts to number of data points

### Animation
- No animation on initial render (static chart)
- Hover interaction shows tooltip immediately
- Bar hover highlights with light blue overlay (rgba(59, 130, 246, 0.1))

### Typography
- Chart title: text-2xl font-semibold
- Description: text-sm text-muted-foreground
- Axis labels: fontSize 12px
- Tooltip: font-semibold for values, text-gray-600 for labels
