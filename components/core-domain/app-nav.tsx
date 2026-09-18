"use client";

import Link from "next/link";
import "./app-nav.css";
import { useEffect, useMemo, useState } from "react";
import { CalendarIcon, DatabaseIcon, GearIcon, HelpIcon, LogoMark, MessageIcon, UsersIcon } from "@/components/icons";

type WorkspaceMembership = {
  workspaceId: string;
  workspaceName: string;
  workspaceStatus: string;
  role: "OWNER" | "ADMIN" | "STAFF";
};

type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string;
  conversationId: string | null;
  readAt: string | null;
  createdAt: string;
};

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
  const [workspaces, setWorkspaces] = useState<WorkspaceMembership[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState("");
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/workspaces", { cache: "no-store" }).then(async (response) => response.ok ? response.json() : null),
      fetch("/api/notifications?limit=20", { cache: "no-store" }).then(async (response) => response.ok ? response.json() : null),
    ]).then(([workspaceData, notificationData]) => {
      if (cancelled) return;
      setWorkspaces(workspaceData?.workspaces ?? []);
      setActiveWorkspaceId(workspaceData?.activeWorkspaceId ?? "");
      setNotifications(notificationData?.items ?? []);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const unread = useMemo(() => notifications.filter((item) => !item.readAt).length, [notifications]);
  const activeWorkspace = workspaces.find((workspace) => workspace.workspaceId === activeWorkspaceId) ?? null;

  async function switchWorkspace(workspaceId: string) {
    if (!workspaceId || workspaceId === activeWorkspaceId || switching) return;
    setSwitching(true);
    try {
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      if (!response.ok) return;
      window.location.reload();
    } finally {
      setSwitching(false);
    }
  }

  async function openNotification(item: NotificationItem) {
    if (!item.readAt) {
      const response = await fetch(`/api/notifications/${item.id}/read`, { method: "POST" });
      if (response.ok) {
        setNotifications((current) => current.map((entry) => entry.id === item.id ? { ...entry, readAt: new Date().toISOString() } : entry));
      }
    }
    setNotificationsOpen(false);
    if (item.conversationId) window.location.assign("/inbox");
  }

  return (
    <aside className={className}>
      <Link className="appBrand" href="/dashboard"><LogoMark size={37} /><strong>AI Caller</strong></Link>

      <div className="navWorkspaceControls">
        <label>
          <span>Workspace</span>
          <select
            aria-label="Active workspace"
            value={activeWorkspaceId}
            disabled={switching || workspaces.length < 2}
            onChange={(event) => void switchWorkspace(event.target.value)}
          >
            {workspaces.map((workspace) => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.workspaceName}</option>)}
          </select>
        </label>
        {activeWorkspace && <small>{activeWorkspace.role}</small>}
        <button
          type="button"
          className="navNotificationButton"
          aria-label="Notifications"
          aria-expanded={notificationsOpen}
          onClick={() => setNotificationsOpen((value) => !value)}
        >
          <span aria-hidden>♧</span>
          {unread > 0 && <b>{Math.min(unread, 99)}</b>}
        </button>
        {notificationsOpen && (
          <div className="navNotificationPanel">
            <div className="navNotificationHeading"><strong>Notifications</strong><span>{unread} unread</span></div>
            {!notifications.length && <p>No notifications yet.</p>}
            {notifications.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`navNotificationItem ${item.readAt ? "" : "unread"}`}
                onClick={() => void openNotification(item)}
              >
                <strong>{item.title}</strong>
                <span>{item.body}</span>
                <small>{new Date(item.createdAt).toLocaleString()}</small>
              </button>
            ))}
          </div>
        )}
      </div>

      <nav className="appNav" aria-label="Main navigation">
        {items.map((item) => (
          <Link key={item.label} href={item.href} className={`appNavItem ${item.label === active ? "active" : ""}`}>
            <span className="appNavIcon">{item.icon}</span><span>{item.label}</span>
            {item.label === "Inbox" && unread > 0 && <b className="navBadge">{Math.min(unread, 99)}</b>}
          </Link>
        ))}
      </nav>
      <a className="sidebarHelp" href="mailto:support@aicaller.com"><span><HelpIcon size={18} /></span><div><strong>Need help?</strong><small>Contact support</small></div></a>
    </aside>
  );
}
