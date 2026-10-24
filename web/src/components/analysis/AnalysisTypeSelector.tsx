import { JuiceCatalog } from './JuiceCatalog';
import { juiceTypes, type JuiceType } from '@/lib/juice-types';
export type AnalysisType = JuiceType;
export const analysisTypes = juiceTypes;
export const everydayJuices = Object.fromEntries(juiceTypes.map(type=>[type.id,{title:type.title,description:type.description}]));
export default function AnalysisTypeSelector({onSelectType,loading,preferredId}:{onSelectType:(type:AnalysisType)=>void;loading:boolean;preferredId?:string}) {
 return <JuiceCatalog compact onSelect={onSelectType} disabled={loading} preferredId={preferredId}/>;
}
