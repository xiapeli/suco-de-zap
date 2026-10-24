import { createContext, useContext } from 'react';
import { ConvexReactClient } from 'convex/react';
import { ConvexAuthProvider } from '@convex-dev/auth/react';

const cloudUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
const cloudClient = cloudUrl && /^https:\/\/[a-z0-9-]+\.convex\.cloud$/.test(cloudUrl) ? new ConvexReactClient(cloudUrl) : null;
const CloudEnabled = createContext(false);
export const useCloudEnabled = () => useContext(CloudEnabled);
export function CloudProvider({ children }: { children: React.ReactNode }) {
  return <CloudEnabled.Provider value={!!cloudClient}>{cloudClient ? <ConvexAuthProvider client={cloudClient}>{children}</ConvexAuthProvider> : children}</CloudEnabled.Provider>;
}
