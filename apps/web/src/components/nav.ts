import {
  ArrowLeftRight,
  Boxes,
  LayoutDashboard,
  MapPin,
  Package,
  ScrollText,
  ShoppingCart,
  TrendingUp,
  Truck,
} from 'lucide-react';

export interface NavItem {
  label: string;
  to: string;
  icon: typeof Package;
  /** Sections whose epics have not landed yet. Shown, but not pretending to work. */
  planned?: boolean;
  /**
   * Hidden from anyone below admin. Not a security control — the server refuses
   * the data either way — but a link that always answers 403 is noise in the
   * sidebar of everyone who cannot use it.
   */
  adminOnly?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard },
  { label: 'Items', to: '/items', icon: Package },
  { label: 'Locations', to: '/locations', icon: MapPin, planned: true },
  { label: 'Movements', to: '/movements', icon: ArrowLeftRight },
  { label: 'Purchase orders', to: '/purchase-orders', icon: ShoppingCart, planned: true },
  { label: 'Suppliers', to: '/suppliers', icon: Truck, planned: true },
  { label: 'Analytics', to: '/analytics', icon: TrendingUp, planned: true },
  { label: 'Audit log', to: '/audit', icon: ScrollText, adminOnly: true },
];

export const APP_ICON = Boxes;
