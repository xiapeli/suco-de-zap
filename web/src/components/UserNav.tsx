import React, { useState } from 'react';
import { useAuthActions } from '@convex-dev/auth/react';
import { useCloudEnabled } from './CloudProvider';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Settings, LogOut } from 'lucide-react';

function UserNavMenu({ endSession, destination }: {endSession?: () => Promise<void>; destination: string}) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [pending,setPending] = useState(false);

  if (!user) return null;

  const initials =
    user.name
      .split(' ')
      .filter(Boolean)
      .map((part) => part[0])
      .join('')
      .toUpperCase()
      .slice(0, 2) || 'EU';

  const handleSignOut = async () => {
    if(pending)return;setPending(true);logout();
    try { await endSession?.(); } finally { navigate(destination, {replace:true}); }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" aria-label="Abrir menu da conta" className="relative h-11 w-11 rounded-full">
          <Avatar className="h-8 w-8">
            <AvatarFallback className="bg-emerald-100 text-emerald-700">{initials}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56" align="end" forceMount>
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col space-y-1">
            <p className="text-sm font-medium leading-none">{user.name}</p>
            <p className="text-xs leading-none text-muted-foreground">Sua conta Suco de Zap</p>
          </div>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        <DropdownMenuItem onClick={() => navigate('/settings')}>
          <Settings className="mr-2 h-4 w-4" />
          <span>Configurações</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem disabled={pending} onClick={handleSignOut}>
          <LogOut className="mr-2 h-4 w-4" />
          <span>{pending ? 'Saindo…' : 'Sair'}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

}
function NativeUserNav() { const {signOut}=useAuthActions(); return <UserNavMenu endSession={signOut} destination="/account"/>; }
export function UserNav() { return useCloudEnabled()?<NativeUserNav/>:<UserNavMenu destination="/auth"/>; }
