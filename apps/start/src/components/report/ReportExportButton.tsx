import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAppParams } from '@/hooks/use-app-params';
import { useTRPC } from '@/integrations/trpc/react';
import { useSelector } from '@/redux';
import { canExportReport, exportReportCsv } from '@/utils/report-export';
import { useQueryClient } from '@tanstack/react-query';
import { DownloadIcon, FileSpreadsheetIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

/**
 * "Export" menu for the report editor. One format today (CSV); the menu
 * exists so more can be added without moving the entry point.
 */
export function ReportExportButton() {
  const report = useSelector((state) => state.report);
  const { projectId } = useAppParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [isExporting, setIsExporting] = useState(false);

  if (!report.ready || !canExportReport(report)) {
    return null;
  }

  const handleCsv = async () => {
    setIsExporting(true);
    try {
      const rows = await exportReportCsv({
        trpc,
        queryClient,
        report: { ...report, projectId },
      });
      if (rows === 0) {
        toast('Nothing to export', {
          description: 'The chart has no data for this range.',
        });
      }
    } catch {
      toast.error('Export failed', {
        description: 'Nothing was downloaded. Try again in a moment.',
      });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={isExporting} icon={DownloadIcon}>
          {isExporting ? 'Exporting…' : 'Export'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={handleCsv}>
          <FileSpreadsheetIcon size={16} className="mr-2" />
          CSV
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
