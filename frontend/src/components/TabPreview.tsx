import { useEffect, useRef, useState } from 'react';
import { useCoverRect } from '../rdp';

/** What a tab shows while hovered: a picture of its remote screen, or its last terminal lines. */
export interface TabPreviewData {
  image?: string;
  lines?: string[];
}

/** Hover card under a tab. It cuts a hole into an RDP session below it, so it is never hidden behind one. */
export function TabPreview(props: { anchor: DOMRect; title: string; subtitle: string; load(): Promise<TabPreviewData | null> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<TabPreviewData | null | undefined>(undefined);
  useCoverRect(ref, true, 6);

  useEffect(() => {
    let alive = true;
    props.load().then(
      (d) => alive && setData(d),
      () => alive && setData(null),
    );
    return () => {
      alive = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const width = 300;
  const left = Math.max(8, Math.min(props.anchor.left, window.innerWidth - width - 8));
  return (
    <div ref={ref} className="tab-preview" style={{ left, top: props.anchor.bottom + 6, width }}>
      <div className="tp-head">
        <div className="tp-title">{props.title}</div>
        {props.subtitle && <div className="tp-sub">{props.subtitle}</div>}
      </div>
      {data?.image ? (
        <img className="tp-image" src={data.image} alt="" />
      ) : data?.lines?.length ? (
        <pre className="tp-lines">{data.lines.join('\n')}</pre>
      ) : data === undefined ? (
        <div className="tp-empty">…</div>
      ) : null}
    </div>
  );
}
