import type { ReactNode } from "react";
import { IntegrationReturnBridge } from "./integration-return-bridge";

export default function IntegrationsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <IntegrationReturnBridge />
    </>
  );
}
