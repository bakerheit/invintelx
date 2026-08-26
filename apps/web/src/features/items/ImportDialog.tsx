import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { CsvParseError, autoMapColumns, parseCsv, type ItemImportPreview } from '@invintelx/shared';
import { ApiError } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCommitImport, usePreviewImport } from './api';
import {
  UNMAPPED,
  mappingFromTargets,
  targetOptions,
  targetsFromMapping,
  type ColumnTarget,
} from './importMapping';

interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface LoadedFile {
  name: string;
  csv: string;
  header: string[];
  /** The first data row, shown under each column so a mapping can be sanity-checked. */
  sample: string[];
  dataRows: number;
}

type Step = 'choose' | 'map' | 'review';

const ACTION_VARIANT = {
  create: 'success',
  update: 'default',
  unchanged: 'outline',
  error: 'destructive',
} as const;

/**
 * Upload, map, preview, commit.
 *
 * The file is parsed here as well as on the server, which is not duplication
 * for its own sake: the mapping step cannot be offered without knowing the
 * column headers, and asking the server for them would mean uploading the file
 * twice. The server still re-parses and re-decides everything before it writes
 * — nothing the browser worked out is trusted.
 */
export function ImportDialog({ open, onOpenChange }: ImportDialogProps) {
  const [step, setStep] = useState<Step>('choose');
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [targets, setTargets] = useState<ColumnTarget[]>([]);
  const [preview, setPreview] = useState<ItemImportPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const previewImport = usePreviewImport();
  const commitImport = useCommitImport();

  const reset = useCallback(() => {
    setStep('choose');
    setFile(null);
    setTargets([]);
    setPreview(null);
    setProblem(null);
    previewImport.reset();
    commitImport.reset();
  }, [previewImport, commitImport]);

  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const onFileChosen = async (chosen: File) => {
    setProblem(null);
    const csv = await chosen.text();

    try {
      const records = parseCsv(csv);
      const headerRecord = records[0];
      if (!headerRecord) {
        setProblem('That file is empty.');
        return;
      }
      const header = headerRecord.fields.map((field) => field.trim());

      setFile({
        name: chosen.name,
        csv,
        header,
        sample: records[1]?.fields ?? [],
        dataRows: records.length - 1,
      });
      setTargets(targetsFromMapping(header, autoMapColumns(header)));
      setStep('map');
    } catch (error) {
      /*
       * The whole file, refused. There is no partial reading of a file whose
       * quoting the parser could not follow, so the only useful thing to say is
       * where it stopped making sense.
       */
      setProblem(
        error instanceof CsvParseError
          ? `Line ${error.line}: ${error.message}`
          : 'That file could not be read as CSV.',
      );
    }
  };

  const showApiProblem = (error: unknown) => {
    if (!(error instanceof ApiError)) {
      setProblem('Something went wrong reading that file.');
      return;
    }
    const detail = Object.entries(error.fields ?? {})
      .map(([key, message]) => `${key}: ${message}`)
      .join('; ');
    setProblem(detail === '' ? error.message : `${error.message} ${detail}`);
  };

  const runPreview = async () => {
    if (!file) return;
    setProblem(null);
    try {
      setPreview(
        await previewImport.mutateAsync({ csv: file.csv, mapping: mappingFromTargets(targets) }),
      );
      setStep('review');
    } catch (error) {
      showApiProblem(error);
    }
  };

  const runCommit = async () => {
    if (!file) return;
    setProblem(null);
    try {
      const result = await commitImport.mutateAsync({
        csv: file.csv,
        mapping: mappingFromTargets(targets),
      });
      toast.success(
        `Imported ${file.name}: ${result.created} created, ${result.updated} updated` +
          (result.unchanged > 0 ? `, ${result.unchanged} unchanged` : ''),
      );
      close(false);
    } catch (error) {
      showApiProblem(error);
      // Back to the mapping: whatever the server refused, the file has to change.
      setStep('map');
    }
  };

  const skuMapped = targets.includes('sku');
  const pendingWrites = (preview?.created ?? 0) + (preview?.updated ?? 0);
  // A file whose every row already matches is not an error, but there is
  // nothing to press either.
  const canImport = preview !== null && preview.failed === 0 && pendingWrites > 0;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Import items from CSV</DialogTitle>
          <DialogDescription>
            Rows are matched on SKU, so importing the same file twice updates your items rather than
            duplicating them.
          </DialogDescription>
        </DialogHeader>

        {step === 'choose' && (
          <div className="grid gap-3">
            <Label htmlFor="csv-file">CSV file</Label>
            <input
              id="csv-file"
              type="file"
              accept=".csv,text/csv"
              className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-1.5 file:text-sm"
              onChange={(event) => {
                const chosen = event.target.files?.[0];
                if (chosen) void onFileChosen(chosen);
              }}
            />
            <p className="text-sm text-muted-foreground">
              Export your items first to see the columns this understands. Any column it does not
              recognise can be mapped by hand on the next step, or left out.
            </p>
          </div>
        )}

        {step === 'map' && file && (
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              {file.name} — {file.dataRows.toLocaleString()} row
              {file.dataRows === 1 ? '' : 's'}. Check each column before previewing.
            </p>

            <div className="max-h-[45vh] overflow-y-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Column in your file</TableHead>
                    <TableHead>First value</TableHead>
                    <TableHead>Imported as</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {file.header.map((column, index) => (
                    <TableRow key={`${column}-${index}`}>
                      <TableCell className="font-medium">{column || <em>(no header)</em>}</TableCell>
                      <TableCell className="max-w-[16rem] truncate text-muted-foreground">
                        {file.sample[index] ?? ''}
                      </TableCell>
                      <TableCell>
                        <Select
                          value={targets[index] ?? UNMAPPED}
                          onValueChange={(value) =>
                            setTargets((previous) =>
                              previous.map((target, position) =>
                                position === index ? value : target,
                              ),
                            )
                          }
                        >
                          <SelectTrigger
                            className="w-[220px]"
                            aria-label={`Import ${column || `column ${index + 1}`} as`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {targetOptions(column, index, targets).map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {!skuMapped && (
              <p role="alert" className="text-sm text-destructive">
                One column has to be the SKU — it is what an import matches on.
              </p>
            )}
          </div>
        )}

        {step === 'review' && preview && (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="success">{preview.created} to create</Badge>
              <Badge>{preview.updated} to update</Badge>
              <Badge variant="outline">{preview.unchanged} unchanged</Badge>
              {preview.failed > 0 && (
                <Badge variant="destructive">{preview.failed} need fixing</Badge>
              )}
            </div>

            {preview.ignoredColumns.length > 0 && (
              <p className="text-sm text-muted-foreground">
                Not imported: {preview.ignoredColumns.join(', ')}.
              </p>
            )}

            {preview.failed > 0 && (
              <p role="alert" className="text-sm text-destructive">
                Nothing is imported while any row is invalid. Fix these lines in the file and choose
                it again.
              </p>
            )}

            <div className="max-h-[45vh] overflow-y-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">Line</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>What happens</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.rows.map((row) => (
                    <TableRow key={row.line}>
                      <TableCell className="tabular text-muted-foreground">{row.line}</TableCell>
                      <TableCell className="font-medium tabular">{row.sku || '—'}</TableCell>
                      <TableCell className="max-w-[16rem] truncate">{row.name}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={ACTION_VARIANT[row.action]}>{row.action}</Badge>
                          <span className="text-xs text-muted-foreground">
                            {row.action === 'error'
                              ? row.issues.map((issue) => issue.message).join('; ')
                              : row.changedFields.join(', ')}
                          </span>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {preview.rowsTruncated && (
              <p className="text-sm text-muted-foreground">
                Showing the first {preview.rows.length.toLocaleString()} of{' '}
                {preview.totalRows.toLocaleString()} rows. The counts above cover the whole file.
              </p>
            )}
          </div>
        )}

        {problem && (
          <p
            role="alert"
            className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {problem}
          </p>
        )}

        <DialogFooter>
          {step !== 'choose' && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setStep(step === 'review' ? 'map' : 'choose')}
            >
              Back
            </Button>
          )}
          <Button type="button" variant="outline" onClick={() => close(false)}>
            Cancel
          </Button>
          {step === 'map' && (
            <Button
              type="button"
              disabled={!skuMapped || previewImport.isPending}
              onClick={() => void runPreview()}
            >
              {previewImport.isPending ? 'Checking...' : 'Preview'}
            </Button>
          )}
          {step === 'review' && (
            <Button
              type="button"
              disabled={!canImport || commitImport.isPending}
              onClick={() => void runCommit()}
            >
              {commitImport.isPending
                ? 'Importing...'
                : pendingWrites === 0
                  ? 'Nothing to import'
                  : `Import ${pendingWrites.toLocaleString()} row${pendingWrites === 1 ? '' : 's'}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
