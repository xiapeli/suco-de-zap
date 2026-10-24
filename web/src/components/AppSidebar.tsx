import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
  useSidebar,
} from '@/components/ui/sidebar';
import { Search, MessagesSquare, CupSoda, Newspaper, Vault, Settings, Smartphone, BookOpen, SlidersHorizontal, Calendar } from 'lucide-react';

const items = [
  { title: 'Fazer um suco', url: '/', icon: Search },
  { title: 'Conversas', url: '/conversations', icon: MessagesSquare },
  { title: 'Meus tipos', url: '/my-juices', icon: SlidersHorizontal },
  { title: 'Meus sucos', url: '/summaries', icon: CupSoda },
  { title: 'Agenda', url: '/calendar', icon: Calendar },
  { title: 'Resumo do dia', url: '/digest', icon: Newspaper },
  { title: 'Cofre', url: '/cofre', icon: Vault },
  { title: 'Configurações', url: '/settings', icon: Settings },
  { title: 'Guia do Suco', url: '/guide', icon: BookOpen },
  { title: 'Conectar WhatsApp', url: '/onboarding', icon: Smartphone },
];

export type AppSidebarItem = (typeof items)[number];

export function AppSidebar({ navigation = items }: { navigation?: AppSidebarItem[] }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { setOpenMobile } = useSidebar();

  const isActive = (url: string) => {
    if (url === '/') return location.pathname === '/';
    return location.pathname.startsWith(url);
  };

  return (
    <Sidebar className="suco-sidebar">
      <SidebarHeader className="suco-sidebar-header">
        <div className="suco-brand">
          <img
            src="/lovable-uploads/760f3a4d-9f9b-4d74-993c-799ca2cbb297.png"
            alt="Suco de Zap"
            className="w-12 h-12 object-contain"
          />
          <span className="font-bold text-lg">Suco de Zap<span className="suco-brand-note">O que o zap rendeu.</span></span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="sr-only">Navegação principal</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigation.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    isActive={isActive(item.url)}
                    className="suco-nav-item"
                    aria-current={isActive(item.url) ? 'page' : undefined}
                    onClick={() => { navigate(import.meta.env.VITE_SUCO_CONTROL === 'supabase' &&
                      item.url === '/onboarding' ? '/onboarding?reconnect=1' : item.url); setOpenMobile(false); }}
                  >
                    <item.icon className="mr-2 h-4 w-4" />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="suco-sidebar-footer">
        <CupSoda className="h-5 w-5" aria-hidden="true" />
        <p className="text-xs text-muted-foreground">
          A conversa continua sua.<br />O Suco só lê e organiza.
        </p>
      </SidebarFooter>
    </Sidebar>
  );
}
