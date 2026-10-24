
import React from 'react';
import { Progress } from '@/components/ui/progress';
import { LoadingSpinner } from '@/components/ui/loading-spinner';

interface ProgressIndicatorProps {
  progress: number;
  status: string;
  showSpinner?: boolean;
  estimatedTime?: string;
  className?: string;
}

export const ProgressIndicator: React.FC<ProgressIndicatorProps> = ({
  progress,
  status,
  showSpinner = true,
  estimatedTime,
  className = ''
}) => {
  return (
    <div className={`space-y-4 ${className}`}>
      {showSpinner && (
        <LoadingSpinner size="md" message={status} />
      )}
      
      <div className="w-full">
        <Progress value={progress} className="w-full h-2" />
        <div className="flex justify-between items-center mt-2 text-sm text-gray-600">
          <span>{status}</span>
          <span>{progress}%</span>
        </div>
        {estimatedTime && (
          <p className="text-xs text-gray-500 mt-1 text-center">
            Tempo estimado: {estimatedTime}
          </p>
        )}
      </div>
    </div>
  );
};
