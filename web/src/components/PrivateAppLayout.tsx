import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LogOut, Settings } from 'lucide-react';
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/AppSidebar';
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

const pageNames: Record<string, string> = {
  '/': 'Fazer um suco', '/home': 'Fazer um suco', '/account': 'Fazer um suco',
  '/create': 'Fazer um suco', '/conversations': 'Conversas', '/summaries': 'Meus sucos',
  '/my-juices': 'Meus tipos', '/calendar': 'Agenda', '/digest': 'Resumo do dia',
  '/cofre': 'Cofre', '/settings': 'Configurações', '/guide': 'Guia do Suco',
  '/onboarding': 'Conectar WhatsApp',
};
export function PrivateAppLayout({ email, onSignOut, children }: {
  email: string; onSignOut: () => Promise<void>; children: ReactNode;
}) {
  const location = useLocation();
  const page = pageNames[location.pathname] ?? 'Fazer um suco';
  return <SidebarProvider className="suco-platform">
    <a className="suco-skip" href="#conteudo">Pular para o conteúdo</a>
    <div className="min-h-screen flex w-full min-w-0">
      <AppSidebar />
      <SidebarInset className="suco-workspace min-w-0">
        <header className="suco-topbar">
          <div className="flex min-w-0 items-center gap-3">
            <SidebarTrigger className="suco-menu-toggle" aria-label="Abrir ou fechar navegação" />
            <Breadcrumb><BreadcrumbList><BreadcrumbItem className="min-w-0"><BreadcrumbPage>{page}</BreadcrumbPage></BreadcrumbItem></BreadcrumbList></Breadcrumb>
          </div>
          <div className="ml-auto shrink-0"><PrivateAccountMenu email={email} onSignOut={onSignOut} /></div>
        </header>
        <div id="conteudo" tabIndex={-1} className="suco-page flex flex-1 flex-col min-w-0">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </div>
      </SidebarInset>
    </div>
  </SidebarProvider>;
}

export function PrivateAccountMenu({ email, onSignOut }: { email: string; onSignOut: () => Promise<void> }) {
  const navigate = useNavigate();
  return <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" aria-label="Abrir menu da conta" className="relative h-11 w-11 rounded-full">
              <Avatar className="h-8 w-8"><AvatarFallback className="bg-emerald-100 text-emerald-700">{email.slice(0, 1).toUpperCase()}</AvatarFallback></Avatar>
            </Button></DropdownMenuTrigger>
            <DropdownMenuContent className="w-56" align="end" forceMount>
              <DropdownMenuLabel className="font-normal"><div className="flex flex-col space-y-1">
                <p className="text-sm font-medium leading-none truncate">{email}</p>
                <p className="text-xs leading-none text-muted-foreground">Sua conta Suco de Zap</p>
              </div></DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => navigate('/settings')}><Settings className="mr-2 h-4 w-4" />Configurações</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void onSignOut()}><LogOut className="mr-2 h-4 w-4" />Sair</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>;
}
