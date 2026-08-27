import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * The camera path, for anyone without a scanner.
 *
 * Built on the browser's own `BarcodeDetector` rather than a decoding library.
 * That is a deliberate trade: no new dependency and no megabyte of WASM on a
 * phone tethered to warehouse wifi, in exchange for it working on Chrome and
 * Edge — including Chrome on Android, which is the phone in the aisle — and not
 * on Firefox or desktop Safari. The dialog says which it is rather than
 * presenting a viewfinder that will never resolve anything.
 */

interface DetectedBarcode {
  rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<string[]>;
}

/** What a warehouse label actually is, in rough order of how often. */
const WANTED_FORMATS = [
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'code_128',
  'code_39',
  'itf',
  'qr_code',
  'data_matrix',
];

function barcodeDetector(): BarcodeDetectorConstructor | null {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
  return typeof ctor === 'function' ? ctor : null;
}

const UNSUPPORTED =
  'This browser cannot read barcodes from its camera. Chrome or Edge can, including on ' +
  'Android. Otherwise use a scanner, or find the item by SKU above.';

const DENIED =
  'No camera. Either permission was refused or there is no camera on this device — check the ' +
  'site permissions in the address bar and try again.';

/** How often to look at the video. Fast enough to feel instant, slow enough not to cook a phone. */
const DETECT_INTERVAL_MS = 200;

interface CameraScanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A code, exactly as the label carried it. Resolving it is the caller's job. */
  onScan: (code: string) => void;
}

export function CameraScanDialog({ open, onOpenChange, onScan }: CameraScanDialogProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  // The callback is held in a ref so the effect below depends on `open` alone.
  // Re-running it would stop and restart the camera mid-look.
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    if (!open) return;

    setError(null);

    const Detector = barcodeDetector();
    if (!Detector || !navigator.mediaDevices?.getUserMedia) {
      setError(UNSUPPORTED);
      return;
    }

    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Every exit from this effect goes through here. A camera left running is a
    // lit LED on somebody's phone and a battery going flat in an aisle.
    const stop = () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };

    void (async () => {
      try {
        const supported = await Detector.getSupportedFormats();
        const formats = WANTED_FORMATS.filter((format) => supported.includes(format));
        // An empty list would ask for every format the browser has rather than
        // none, which is the right fallback if the intersection comes up dry.
        const detector = new Detector(formats.length > 0 ? { formats } : undefined);

        // The back camera, on a phone. Ignored by a laptop, which has one.
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
        });
        if (stopped) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play().catch(() => undefined);

        const look = async () => {
          if (stopped) return;
          try {
            const found = await detector.detect(video);
            const code = found[0]?.rawValue;
            if (code) {
              stop();
              onOpenChange(false);
              onScanRef.current(code);
              return;
            }
          } catch {
            // One frame the detector could not read is not a failure worth
            // reporting — the next one is 200ms away.
          }
          if (!stopped) timer = setTimeout(() => void look(), DETECT_INTERVAL_MS);
        };
        timer = setTimeout(() => void look(), DETECT_INTERVAL_MS);
      } catch {
        if (!stopped) setError(DENIED);
      }
    })();

    return stop;
  }, [open, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Scan with the camera</DialogTitle>
          <DialogDescription>
            Hold the label in the frame. The item is chosen as soon as a code reads.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : (
          <video
            ref={videoRef}
            data-testid="scan-viewfinder"
            muted
            playsInline
            className="aspect-[4/3] w-full rounded-md bg-muted object-cover"
          />
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
