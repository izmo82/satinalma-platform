// Tek ikon seti: lucide (aynı çizgi kalınlığı ve stil). Uygulama ikonları adla çağırır; dekoratif ikonlar aria-hidden.
import {
  Archive, ArrowRight, Bell, Download, BarChart3, Check, ChevronRight, CircleAlert, CircleHelp, CircleMinus, CircleX, Clock, FileText, Folder, Inbox,
  Info, Lock, LogOut, Package, PenLine, Receipt, RefreshCw, Search, Settings, ShieldCheck, Sparkles, Stamp, TriangleAlert, Upload, Users, Wallet, WifiOff, X, ZoomIn, ZoomOut,
  type LucideIcon,
} from 'lucide-react';

const icons: Record<string, LucideIcon> = {
  check: Check, alert: TriangleAlert, x: CircleX, clock: Clock, info: Info, help: CircleHelp, minus: CircleMinus, shield: ShieldCheck,
  inbox: Inbox, folder: Folder, users: Users, file: FileText, receipt: Receipt, chart: BarChart3, sparkles: Sparkles, lock: Lock,
  wifiOff: WifiOff, refresh: RefreshCw, upload: Upload, chevron: ChevronRight, close: X, zoomIn: ZoomIn, zoomOut: ZoomOut, pen: PenLine,
  bell: Bell, archive: Archive, download: Download, stamp: Stamp, arrow: ArrowRight, logout: LogOut, error: CircleAlert, package: Package, wallet: Wallet,
  search: Search, settings: Settings,
};

export function Icon({ name, size = 16, title, className }: { name: string; size?: number; title?: string; className?: string }) {
  const C = icons[name] ?? Info;
  return <C size={size} strokeWidth={2} className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined} aria-label={title} />;
}
