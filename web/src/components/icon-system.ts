import {
  IconBriefcase,
  IconBriefcaseFilled,
  IconChartDots,
  IconChartDotsFilled,
  IconClipboardCheck,
  IconClipboardCheckFilled,
  IconFileInvoiceFilled,
  IconInfoCircle,
  IconInfoCircleFilled,
  IconLayoutDashboard,
  IconLayoutDashboardFilled,
  IconListCheck,
  IconListCheckFilled,
  IconPackage,
  IconPackages,
  IconPalette,
  IconPaletteFilled,
  IconQuote,
  IconQuoteFilled,
  IconSettings,
  IconSettingsFilled,
  IconSparkles,
  IconSparklesFilled,
  IconUserFilled,
  IconUsers,
  IconUsersGroup,
} from "@tabler/icons-react";
import type { ComponentProps } from "react";

export type QuoteFlyTablerIcon = typeof IconSparkles;
export type QuoteFlyTablerIconProps = ComponentProps<QuoteFlyTablerIcon>;

/**
 * The selective Tabler pilot lives behind this catalog to keep filled emphasis
 * and outline navigation consistent without replacing the utility icon set.
 */
export const TablerIcons = {
  marketing: {
    ai: IconSparklesFilled,
    customer: IconUserFilled,
    quote: IconQuoteFilled,
    work: IconBriefcaseFilled,
    schedule: IconClipboardCheckFilled,
    invoice: IconFileInvoiceFilled,
  },
  workspace: {
    home: { outline: IconLayoutDashboard, filled: IconLayoutDashboardFilled },
    customers: { outline: IconUsers, filled: IconUserFilled },
    team: { outline: IconUsersGroup, filled: IconUsersGroup },
    quotes: { outline: IconQuote, filled: IconQuoteFilled },
    jobs: { outline: IconBriefcase, filled: IconBriefcaseFilled },
    products: { outline: IconPackage, filled: IconPackages },
    followUp: { outline: IconListCheck, filled: IconListCheckFilled },
    analytics: { outline: IconChartDots, filled: IconChartDotsFilled },
    branding: { outline: IconPalette, filled: IconPaletteFilled },
    about: { outline: IconInfoCircle, filled: IconInfoCircleFilled },
    settings: { outline: IconSettings, filled: IconSettingsFilled },
  },
  states: {
    sparkles: { outline: IconSparkles, filled: IconSparklesFilled },
    complete: { outline: IconClipboardCheck, filled: IconClipboardCheckFilled },
  },
} as const;

export type WorkspaceIconName = keyof typeof TablerIcons.workspace;
