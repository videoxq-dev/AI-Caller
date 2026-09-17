import Link from "next/link";
import { CalendarIcon, DatabaseIcon, GearIcon, HelpIcon, LogoMark, MessageIcon, UsersIcon } from "@/components/icons";

const items = [
  { label: "Dashboard", href: "/dashboard", icon: <span aria-hidden>⌂</span> },
  { label: "Inbox", href: "/inbox", icon: <MessageIcon size={20} /> },
  { label: "Contacts", href: "/contacts", icon: <UsersIcon size={20} /> },
  { label: "Appointments", href: "/appointments", icon: <CalendarIcon size={20} /> },
  { label: "AI Agent", href: "/ai-agent", icon: <span aria-hidden>✦</span> },
  { label: "Automations", href: "/automations", icon: <span aria-hidden>ϟ</span> },
  { label: "Integrations", href: "/integrations", icon: <DatabaseIcon size={20} /> },
  { label: "Settings", href: "/settings", icon: <GearIcon size={20} /> },
];

export function AppNav({ active, className = "appSidebar" }: { active: string; className?: string }) {
  return (
    <aside className={className}>
      <Link className="appBrand" href="/dashboard"><LogoMark size={37} /><strong>AI Caller</strong></Link>
      <nav className="appNav" aria-label="Main navigation">
        {items.map((item) => (
          <Link key={item.label} href={item.href} className={`appNavItem ${item.label === active ? "active" : ""}`}>
            <span className="appNavIcon">{item.icon}</span><span>{item.label}</span>
          </Link>
        ))}
      </nav>
      <a className="sidebarHelp" href="mailto:support@aicaller.com"><span><HelpIcon size={18} /></span><div><strong>Need help?</strong><small>Contact support</small></div></a>
    </aside>
  );
}
