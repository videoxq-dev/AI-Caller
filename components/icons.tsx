import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const base = (size = 20) => ({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true });

export function LogoMark({ size = 36, ...props }: IconProps) {
  return <svg {...base(size)} {...props} viewBox="0 0 32 32"><path d="M4 13v6M8 9v14M12 5v22M16 8v16M20 3v26M24 7v18M28 12v8" /></svg>;
}
export function PhoneIcon({ size, ...props }: IconProps) { return <svg {...base(size)} {...props}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07A19.4 19.4 0 0 1 5.15 12.8 19.8 19.8 0 0 1 2.08 4.14 2 2 0 0 1 4.07 2h3a2 2 0 0 1 2 1.72c.12.9.33 1.78.62 2.63a2 2 0 0 1-.45 2.11L8 9.7a16 16 0 0 0 6.3 6.3l1.24-1.24a2 2 0 0 1 2.11-.45c.85.29 1.73.5 2.63.62A2 2 0 0 1 22 16.92Z"/></svg>; }
export function MessageIcon({ size, ...props }: IconProps) { return <svg {...base(size)} {...props}><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/></svg>; }
export function ChatIcon({ size, ...props }: IconProps) { return <svg {...base(size)} {...props}><path d="M8 12h8M8 8h5M5 20l-2 2v-5a7 7 0 0 1-1-3.6A8.4 8.4 0 0 1 10.5 5h3A8.5 8.5 0 0 1 22 13.5 8.5 8.5 0 0 1 13.5 22H10"/></svg>; }
export function UserIcon({ size, ...props }: IconProps) { return <svg {...base(size)} {...props}><circle cx="12" cy="8" r="4"/><path d="M4 22a8 8 0 0 1 16 0"/></svg>; }
export function SparkleIcon({ size, ...props }: IconProps) { return <svg {...base(size)} {...props}><path d="m12 3 1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7ZM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z"/></svg>; }
export function FileIcon({ size, ...props }: IconProps) { return <svg {...base(size)} {...props}><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5M9 13h6M9 17h6"/></svg>; }
export function CalendarIcon({ size, ...props }: IconProps) { return <svg {...base(size)} {...props}><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18m-12 5 2 2 4-4"/></svg>; }
export function DatabaseIcon({ size, ...props }: IconProps) { return <svg {...base(size)} {...props}><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3 1.2 0 2.4-.1 3.4-.3"/><path d="m18 17 1.5 1.5L22 16"/></svg>; }
export function CheckIcon({ size, ...props }: IconProps) { return <svg {...base(size)} {...props}><path d="m5 12 4 4L19 6"/></svg>; }
export function LockIcon({ size, ...props }: IconProps) { return <svg {...base(size)} {...props}><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>; }
export function EyeIcon({ size, ...props }: IconProps) { return <svg {...base(size)} {...props}><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></svg>; }
export function EyeOffIcon({ size, ...props }: IconProps) { return <svg {...base(size)} {...props}><path d="m3 3 18 18M10.6 6.2A10.8 10.8 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-2.3 3M6.6 6.6C3.5 8.6 2 12 2 12s3.5 6 10 6a10.5 10.5 0 0 0 4.2-.8M10.7 10.7a2 2 0 0 0 2.6 2.6"/></svg>; }
export function HelpIcon({ size, ...props }: IconProps) { return <svg {...base(size)} {...props}><circle cx="12" cy="12" r="9"/><path d="M9.7 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1.2.8-1.2 1.7M12 17h.01"/></svg>; }
export function RocketIcon({ size, ...props }: IconProps) { return <svg {...base(size)} {...props}><path d="M14 6 5 15l4 4 9-9 2-6-6 2Z"/><path d="m5 15-2 6 6-2M13 7l4 4M8 11l5 5"/></svg>; }
export function ArrowRightIcon({ size, ...props }: IconProps) { return <svg {...base(size)} {...props}><path d="M5 12h14M13 6l6 6-6 6"/></svg>; }
