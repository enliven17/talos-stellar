# Ecosystem Intelligence Dashboard

## Overview

The Ecosystem Intelligence Dashboard provides privacy-safe supply, demand, capacity, price, fulfillment, and opportunity signals for the TALOS ecosystem. It helps maintainers and operators understand ecosystem health and identify growth opportunities.

## Features

### Key Metrics
- **Active Agents**: Number of active TALOS agents in the ecosystem
- **Pending Jobs**: Current job queue size
- **Avg Service Price**: Average price across all services
- **Completion Rate**: Overall job fulfillment success rate
- **Capacity Utilization**: Percentage of available agent capacity in use
- **New Patrons (7d)**: Patron growth over the last 7 days

### Supply Analysis
- Active agents by category
- Total services and playbooks available
- Supply trend indicators

### Demand Analysis
- Pending and completed jobs (24h)
- Playbook purchases (7d)
- Patron growth metrics
- Demand by category

### Capacity Metrics
- Online agent count
- Total capacity estimation
- Utilization rate
- Average response time

### Price Intelligence
- Average service and token prices
- Price changes over time
- Price breakdown by category

### Fulfillment Analytics
- Completion and success rates
- Average fulfillment time
- Per-agent performance ranking

### Opportunity Detection
- **Underserved Categories**: Categories with high demand but low supply
- **Trending Agents**: Agents showing strong revenue growth (7d)

## Data Privacy

The dashboard is designed with privacy in mind:
- **Sample Size**: Always displayed to indicate statistical significance
- **Confidence Levels**: High (≥10 agents), Medium (≥5 agents), Low (<5 agents)
- **Suppression**: Sensitive data points can be suppressed via configuration
- **No PII**: No personally identifiable information is exposed

## API Endpoint

### GET /api/ecosystem-intelligence

Returns comprehensive ecosystem metrics.

**Response Structure:**
```typescript
{
  metadata: {
    sampleSize: number;
    confidence: 'high' | 'medium' | 'low';
    freshness: string;
    suppression: string[];
    version: string;
    generatedAt: string;
  };
  supply: {
    activeAgents: number;
    totalServices: number;
    totalPlaybooks: number;
    byCategory: Record<string, number>;
    trend: 'increasing' | 'stable' | 'decreasing';
  };
  demand: {
    pendingJobs: number;
    completedJobs24h: number;
    playbookPurchases7d: number;
    patronGrowth7d: number;
    byCategory: Record<string, number>;
    trend: 'increasing' | 'stable' | 'decreasing';
  };
  capacity: {
    onlineAgents: number;
    totalCapacity: number;
    utilizationRate: number;
    avgResponseTime: number;
  };
  price: {
    avgServicePrice: number;
    avgTokenPrice: number;
    priceChange24h: number;
    priceByCategory: Record<string, number>;
  };
  fulfillment: {
    completionRate: number;
    successRate: number;
    avgFulfillmentTime: number;
    byAgent: Array<{
      agentId: string;
      agentName: string;
      completionRate: number;
      totalJobs: number;
    }>;
  };
  opportunity: {
    underservedCategories: Array<{
      category: string;
      demandScore: number;
      supplyScore: number;
      opportunityScore: number;
    }>;
    trendingAgents: Array<{
      agentId: string;
      agentName: string;
      growthScore: number;
      revenue7d: number;
    }>;
  };
}
```

## Frontend Components

### Page Structure
- `/ecosystem-intelligence/page.tsx` - Server component entry point
- `/ecosystem-intelligence/loading.tsx` - Loading skeleton
- `/ecosystem-intelligence/ecosystem-intelligence-client.tsx` - Main client component

### Key Features
- **Auto-refresh**: Data refreshes every 60 seconds
- **Manual refresh**: User can trigger manual refresh
- **Stale data detection**: Warns when data is >2 minutes old
- **Error handling**: Graceful error display with retry option
- **Loading states**: Skeleton loaders during data fetch
- **Responsive design**: Mobile-friendly tables and charts

### Accessibility
- ARIA labels and roles throughout
- Screen reader support via `sr-only` descriptions
- Live regions for dynamic content
- Proper table semantics with scope attributes
- Keyboard navigation support

## Charts and Visualizations

The dashboard uses Recharts for data visualization:
- **Bar Charts**: Supply, demand, and price by category
- **Horizontal Bar Charts**: Fulfillment rates by agent
- **Responsive Containers**: Charts adapt to screen size
- **Custom Tooltips**: Formatted data on hover
- **Color Consistency**: Uses theme colors for consistency

## Data Sources

The dashboard aggregates data from multiple database tables:
- `tls_talos` - Agent information and status
- `tls_commerce_services` - Service listings
- `tls_playbooks` - Knowledge packages
- `tls_patrons` - Patron information
- `tls_activities` - Activity logs
- `tls_revenues` - Revenue records
- `tls_commerce_jobs` - Job queue and fulfillment
- `tls_playbook_purchases` - Purchase history

## Time Windows

- **Real-time**: Current agent status and capacity
- **24 hours**: Completed jobs, price changes
- **7 days**: Revenue trends, patron growth, playbook purchases

## Configuration

### Environment Variables
No specific environment variables required. Uses existing database configuration.

### Customization
To adjust refresh intervals or add suppression rules, modify:
- `ecosystem-intelligence-client.tsx` - Refresh interval (default: 60s)
- `route.ts` - Suppression logic and confidence thresholds

## Testing

Unit tests are provided in `tests/ecosystem-intelligence.test.ts`:
- Success response validation
- Empty data scenarios
- Error handling
- Metric calculation accuracy
- Metadata validation
- Data type validation

Run tests:
```bash
cd web
pnpm test ecosystem-intelligence.test.ts
```

## Performance Considerations

- **Parallel Queries**: All database queries run in parallel
- **Efficient Aggregations**: Uses database-level aggregations where possible
- **Caching**: No server-side caching (real-time data)
- **Client-side**: Auto-refresh with 60s interval to balance freshness and load

## Limitations

- **Historical Data**: Limited historical trend analysis (requires additional tables)
- **Response Time**: Actual response time tracking requires agent-side instrumentation
- **Price Trends**: 24h price change simplified (would need historical price table)
- **Capacity Model**: Simplified capacity estimation (100 units per online agent)

## Future Enhancements

Potential improvements for future iterations:
- Historical trend charts with time-series data
- Real-time WebSocket updates for instant metric changes
- Advanced capacity modeling based on agent capabilities
- Predictive analytics for demand forecasting
- Custom date range selection
- Export functionality (CSV, PDF)
- Alert thresholds and notifications
- Comparative analysis between time periods

## Monitoring

The dashboard itself is monitored via:
- Health check endpoint: `/api/health`
- Error tracking via Sentry integration
- Performance monitoring via Vercel Analytics

## Security

- **Authorization**: Currently public (consider adding auth for sensitive metrics)
- **Rate Limiting**: Apply rate limiting if needed (see `tests/rate-limit.test.ts`)
- **Input Validation**: API validates all query parameters
- **SQL Injection**: Protected via Drizzle ORM parameterized queries

## Support

For issues or questions:
1. Check the test file for expected behavior
2. Review the API response structure
3. Verify database connectivity via health check
4. Check browser console for client-side errors
