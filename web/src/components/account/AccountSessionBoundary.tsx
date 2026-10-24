import { Component, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/** A revoked reactive Convex query must offer reauthentication instead of unmounting the app. */
export class AccountSessionBoundary extends Component<{children:ReactNode;onRecover:()=>void},{failed:boolean}> {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){
    if(!this.state.failed)return this.props.children;
    return <div className="account-auth" role="alert"><img src="/lovable-uploads/760f3a4d-9f9b-4d74-993c-799ca2cbb297.png" alt="Suco de Zap" width="72" height="72"/><h1>Vamos entrar novamente.</h1><p>Não conseguimos confirmar sua sessão. Seus sucos salvos continuam na conta. Entre novamente para retomar seu espaço.</p><Button className="mt-6" onClick={this.props.onRecover}>Entrar novamente</Button></div>;
  }
}
