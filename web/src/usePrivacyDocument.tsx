import { useEffect, useState, type ReactNode } from 'react';
import { fetchPrivacyDocument, type PrivacyDocument, type PrivacyResult } from './api/privacy';
import { ErrorState, LoadingState } from './App';

export function usePrivacyDocument(baseUrl: string = ''): PrivacyResult | null {
  const [result, setResult] = useState<PrivacyResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    fetchPrivacyDocument(baseUrl).then((value) => {
      if (!cancelled) setResult(value);
    });
    return () => {
      cancelled = true;
    };
  }, [baseUrl]);

  return result;
}

export function PrivacyGate({
  result,
  children,
}: {
  result: PrivacyResult | null;
  children: (document: PrivacyDocument) => ReactNode;
}): ReactNode {
  if (!result) return <LoadingState message="Загрузка документа о персональных данных." />;
  if (!result.ok) {
    return (
      <ErrorState
        message={result.error.message}
        action={
          <button
            className="button button-secondary"
            type="button"
            aria-label="Повторить загрузку документа"
            onClick={() => window.location.reload()}
          >
            Повторить
          </button>
        }
      />
    );
  }
  return children(result.document);
}
