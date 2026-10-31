// Renderless: holds one drilldown level's shape open while mounted and reports its rows.
import { useEffect, useMemo } from 'react';
import { elementLevelRequest, useElementLevel, type ElementLevelRequest, type ElementRow } from '../hooks/useElementLevel';

interface Props {
  assetId: string | null | undefined;
  /** Path of the node whose children this level shows; null = the root level. */
  prefix: string | null;
  leafDepth: number;
  onRows: (key: string, rows: ElementRow[]) => void;
}

function Feed({ req, onRows }: { req: ElementLevelRequest; onRows: Props['onRows'] }) {
  const rows = useElementLevel(req);
  useEffect(() => {
    onRows(req.key, rows);
  }, [req.key, rows, onRows]);
  return null;
}

export default function ElementLevelSubscription({ assetId, prefix, leafDepth, onRows }: Props) {
  const req = useMemo(() => elementLevelRequest(assetId, prefix, leafDepth), [assetId, prefix, leafDepth]);
  if (!req) return null;
  return <Feed key={req.key} req={req} onRows={onRows} />;
}
