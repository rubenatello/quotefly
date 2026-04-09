# Brand Colors and Icons

## Updated Brand Palette (Aligned with Logo)

Sourced from logo.png and favicon.png designs.

### Primary Colors

- **Quotefly Blue**: `#1E88E5` - Main brand color, professional and trustworthy
- **Quotefly Orange**: `#FF6B35` - Accent and call-to-action, energetic and friendly
- **Quotefly Gold**: `#FFC107` - Secondary accent, premium feel
- **Dark Blue**: `#1565C0` - Headers and emphasis
- **Light Blue**: `#42A5F5` - Backgrounds and subtle elements

### Usage in CSS

```css
:root {
  --quotefly-blue: #1e88e5;
  --quotefly-orange: #ff6b35;
  --quotefly-gold: #ffc107;
  --quotefly-dark-blue: #1565c0;
  --quotefly-light-blue: #42a5f5;
}
```

## Icon System

### Using Lucide React

The project uses **Lucide React** for UI and business icons. All icons are imported from `lucide-react` and re-exported through `web/src/components/Icons.tsx` for consistency.

**Available UI Icons:**
- Quote, Invoice, Customer, Call, Email, Message, Settings, Price, Send, Edit, Delete, Menu, Close, Check, Clock

**Example usage:**

```tsx
import { QuoteIcon, CustomerIcon } from "./components/Icons";

export function MyComponent() {
  return (
    <div>
      <QuoteIcon size={24} className="text-quotefly-blue" />
      <CustomerIcon size={20} />
    </div>
  );
}
```

### Trade-Specific Icons

Mapped in `TradeIcons` object:

| Trade | Icon | Notes |
|-------|------|-------|
| HVAC | Zap | Represents electrical/energy |
| PLUMBING | Wrench | Standard tool representation |
| FLOORING | Hammer | Construction tool |
| ROOFING | Hammer | Construction tool |
| GARDENING | Leaf | Natural/organic |

**Usage:**

```tsx
import { getTradeIcon } from "./components/Icons";

const icon = getTradeIcon("HVAC", { size: 32, className: "text-quotefly-blue" });
```

### Custom SVG Icons

For better trade-specific representation, replace icons in `TradeIcons` with custom SVGs:

1. Create SVG file in `web/src/assets/icons/`
2. Import as React component
3. Replace the Lucide icon mapping

**Example: Custom HVAC Icon**

```tsx
import HvacIcon from "../assets/icons/hvac.svg?react";

TradeIcons.HVAC = HvacIcon;
```

### Tailwind Integration

Use Lucide directly with Tailwind classes:

```tsx
import { Wrench } from "lucide-react";

<Wrench className="w-6 h-6 text-quotefly-orange stroke-2" />
```

## Color Tokens in Tailwind

Extend tailwind.config.js to include QuoteFly colors:

```js
export default {
  theme: {
    extend: {
      colors: {
        "quotefly-blue": "#1e88e5",
        "quotefly-orange": "#ff6b35",
        "quotefly-gold": "#ffc107",
        "quotefly-dark-blue": "#1565c0",
        "quotefly-light-blue": "#42a5f5",
      },
    },
  },
};
```

Then use in JSX:

```tsx
<button className="bg-quotefly-blue hover:bg-quotefly-dark-blue text-white">
  Create Quote
</button>
```

## Migration Notes

Previous color palette (tiger-flame, dusty-denim, etc.) has been replaced to match the official QuoteFly branding from the logo assets.
