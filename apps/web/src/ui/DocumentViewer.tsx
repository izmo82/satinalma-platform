import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { apiBlob } from '../lib/api.ts';
import { Icon } from './icons.tsx';
import { ErrorState, Loading } from './kit.tsx';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface Region { id: string; page: number; bbox: { x: number; y: number; w: number; h: number }; label: string }

/**
 * Kaynak belge görüntüleyici: orijinal baytlar yetkili uçtan alınır, yalnız istemcide çizilir (orijinal değişmez).
 * Bölgeler normalize koordinatla (0..1) sayfa üstüne yerleşir; klavye ile seçilebilir düğmelerdir.
 */
export function DocumentViewer({ versionId, mimeType, regions = [], targetPage, selectedRegion, onSelectRegion }: {
  versionId: string; mimeType: string; regions?: Region[]; targetPage?: number | null; selectedRegion?: string | null; onSelectRegion?: (id: string) => void;
}) {
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [scale, setScale] = useState(1.1);
  const [attempt, setAttempt] = useState(0);
  const pagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    setDoc(null); setText(null); setImageUrl(null); setError(null);
    (async () => {
      try {
        const blob = await apiBlob(`/api/v1/document-versions/${versionId}/content`);
        if (cancelled) return;
        if (mimeType === 'application/pdf') {
          // Güvenlik: XFA kapalı; yamalı pdf.js (>=6.2.108, GHSA-hq66-cqwq-w95j). Belge betikleri çalıştırılmaz.
          const d = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), enableXfa: false }).promise;
          if (cancelled) return;
          // İlk ölçek: sayfa genişliğine sığdır (dar ekranda yatay kaydırma olmasın).
          const first = await d.getPage(1);
          const w = first.getViewport({ scale: 1 }).width;
          const avail = (pagesRef.current?.clientWidth ?? 800) - 32;
          setScale(Math.max(0.4, Math.min(1.4, avail / w)));
          setDoc(d);
        } else if (mimeType.startsWith('image/')) {
          url = URL.createObjectURL(blob);
          setImageUrl(url);
        } else {
          setText(await blob.text());
        }
      } catch (e) { if (!cancelled) setError(e); }
    })();
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [versionId, mimeType, attempt]);

  useEffect(() => {
    if (!targetPage || !pagesRef.current) return;
    const el = pagesRef.current.querySelector<HTMLElement>(`[data-page="${targetPage}"]`);
    el?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [targetPage, doc]);

  return (
    <div className="viewer" aria-label="Kaynak belge">
      <div className="viewer-toolbar">
        <span className="subtle">{doc ? `${doc.numPages} sayfa` : mimeType}</span>
        <span style={{ flex: 1 }} />
        {doc && <>
          <button className="btn btn-sm" onClick={() => setScale((s) => Math.max(0.4, s - 0.2))} aria-label="Uzaklaştır"><Icon name="zoomOut" /></button>
          <span className="subtle num" aria-live="polite">%{Math.round(scale * 100)}</span>
          <button className="btn btn-sm" onClick={() => setScale((s) => Math.min(3, s + 0.2))} aria-label="Yakınlaştır"><Icon name="zoomIn" /></button>
        </>}
      </div>
      <div className="viewer-pages" ref={pagesRef}>
        {error ? <ErrorState error={error} onRetry={() => setAttempt((a) => a + 1)} />
          : doc ? Array.from({ length: doc.numPages }, (_, i) => (
            <PdfPage key={i} doc={doc} pageNo={i + 1} scale={scale} isTarget={targetPage === i + 1}
              regions={regions.filter((r) => r.page === i + 1)} selectedRegion={selectedRegion} onSelectRegion={onSelectRegion} />
          ))
          : imageUrl ? <img src={imageUrl} alt="Kaynak belge görüntüsü" style={{ maxWidth: '100%', background: '#fff' }} />
          : text != null ? <pre className="mono" style={{ background: '#fff', padding: 16, whiteSpace: 'pre-wrap', width: '100%', overflowWrap: 'anywhere' }}>{text}</pre>
          : <Loading label="Belge açılıyor" />}
      </div>
    </div>
  );
}

function PdfPage({ doc, pageNo, scale, isTarget, regions, selectedRegion, onSelectRegion }: {
  doc: pdfjs.PDFDocumentProxy; pageNo: number; scale: number; isTarget: boolean; regions: Region[]; selectedRegion?: string | null; onSelectRegion?: (id: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    let task: pdfjs.RenderTask | null = null;
    let cancelled = false;
    (async () => {
      const page = await doc.getPage(pageNo);
      const vp = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;
      const c = canvas.current;
      if (!c || cancelled) return;
      c.width = Math.floor(vp.width * dpr); c.height = Math.floor(vp.height * dpr);
      c.style.width = `${vp.width}px`; c.style.height = `${vp.height}px`;
      setSize({ w: vp.width, h: vp.height });
      task = page.render({ canvas: c, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      await task.promise.catch(() => {});
    })();
    return () => { cancelled = true; task?.cancel(); };
  }, [doc, pageNo, scale]);
  return (
    <div className={`viewer-page${isTarget ? ' is-target' : ''}`} data-page={pageNo} role="group" aria-label={`Sayfa ${pageNo}`}>
      <span className="page-label">Sayfa {pageNo}</span>
      <canvas ref={canvas} aria-hidden="true" />
      {size && regions.map((r) => (
        <button key={r.id} type="button" className={`region${selectedRegion === r.id ? ' is-selected' : ''}`}
          style={{ left: r.bbox.x * size.w, top: r.bbox.y * size.h, width: r.bbox.w * size.w, height: r.bbox.h * size.h }}
          aria-label={`${r.label}, sayfa ${pageNo}`} aria-pressed={selectedRegion === r.id} onClick={() => onSelectRegion?.(r.id)}>
          <span className="region-label">{r.label}</span>
        </button>
      ))}
    </div>
  );
}
