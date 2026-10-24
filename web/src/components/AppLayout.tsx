
import React, { Suspense, useContext } from 'react';
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/AppSidebar';
import { PrivateAccountMenu } from '@/components/PrivateAppLayout';
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import { useLocation } from 'react-router-dom';
import { ConnectionNotice } from './ConnectionNotice';
import { TrialNotice } from './TrialNotice';

const LegacyUserNav = import.meta.env.VITE_SUCO_CONTROL === 'supabase' ? null :
  React.lazy(() => import('@/components/UserNav').then(module => ({ default: module.UserNav })));
export const PrivateLayoutContext = React.createContext<{ email: string; onSignOut: () => Promise<void> } | null>(null);

interface AppLayoutProps {
  children: React.ReactNode;
  title?: string;
  breadcrumbs?: Array<{ label: string; href?: string }>;
}

export function AppLayout({ children, title, breadcrumbs }: AppLayoutProps) {
  const location = useLocation();
  const privateAccount = useContext(PrivateLayoutContext);

  // Generate default breadcrumbs based on current path
  const generateBreadcrumbs = () => {
    const pathMap: Record<string, string> = {
      '/': 'Fazer um suco',
      '/conversations': 'Conversas',
      '/summaries': 'Sucos',
      '/my-juices': 'Meus tipos',
      '/digest': 'Digest diário',
      '/cofre': 'Cofre',
      '/settings': 'Configurações',
      '/onboarding': 'Primeiros passos',
    };

    if (location.pathname === '/') return [{ label: 'Fazer um suco' }];
    return [
      { label: 'Início', href: '/' },
      { label: pathMap[location.pathname] || 'Página' }
    ];
  };

  const currentBreadcrumbs = breadcrumbs || generateBreadcrumbs();

  return (
    <SidebarProvider className="suco-platform">
      <a className="suco-skip" href="#conteudo">Pular para o conteúdo</a>
      <div className="min-h-screen flex w-full min-w-0">
        <AppSidebar />
        <SidebarInset className="suco-workspace min-w-0">
          <header className="suco-topbar">
            <div className="flex min-w-0 items-center gap-3">
              <SidebarTrigger className="suco-menu-toggle" aria-label="Abrir ou fechar navegação" />
              <Breadcrumb>
                <BreadcrumbList>
                  {currentBreadcrumbs.map((crumb, index) => (
                    <React.Fragment key={index}>
                      <BreadcrumbItem className={index === currentBreadcrumbs.length - 1 ? 'min-w-0' : 'hidden md:block'}>
                        {crumb.href && index < currentBreadcrumbs.length - 1 ? (
                          <BreadcrumbLink href={crumb.href}>
                            {crumb.label}
                          </BreadcrumbLink>
                        ) : (
                          <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                        )}
                      </BreadcrumbItem>
                      {index < currentBreadcrumbs.length - 1 && (
                        <BreadcrumbSeparator className="hidden md:block" />
                      )}
                    </React.Fragment>
                  ))}
                </BreadcrumbList>
              </Breadcrumb>
            </div>
            <div className="ml-auto shrink-0">
              {privateAccount ? <PrivateAccountMenu {...privateAccount} /> :
                LegacyUserNav ? <Suspense fallback={null}><LegacyUserNav /></Suspense> : null}
            </div>
          </header>
          <div id="conteudo" tabIndex={-1} className="suco-page flex flex-1 flex-col min-w-0">
            <div className="mx-auto w-full max-w-6xl space-y-4 suco-notices"><ConnectionNotice /><TrialNotice /></div>
            {title && (
              <div className="mx-auto w-full max-w-6xl suco-page-heading">
                <h1>{title}</h1>
              </div>
            )}
            <div className="mx-auto w-full max-w-6xl">
              {children}
            </div>
          </div>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
