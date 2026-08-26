import {
  ArrowLeftRight,
  Boxes,
  LayoutDashboard,
  MapPin,
  Package,
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
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard },
  { label: 'Items', to: '/items', icon: Package },
  { label: 'Locations', to: '/locations', icon: MapPin, planned: true },
  { label: 'Movements', to: '/movements', icon: ArrowLeftRight },
  { label: 'Purchase orders', to: '/purchase-orders', icon: ShoppingCart, planned: true },
  { label: 'Suppliers', to: '/suppliers', icon: Truck, planned: true },
  { label: 'Analytics', to: '/analytics', icon: TrendingUp, planned: true },
];

export const APP_ICON = Boxes;
