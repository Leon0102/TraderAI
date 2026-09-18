import { getFeedProvenance } from '../api/stockApi';

function formatDate(value?: string): string | null {
  if (!value) return null;
  const match = value.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : null;
}

export function renderFeedMeta(elementId: string, feedKey: string, label: string, fallbackAsOf?: string) {
  const element = document.getElementById(elementId);
  const provenance = getFeedProvenance(feedKey);
  if (!element || !provenance) return;
  const received = new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit',
  }).format(new Date(provenance.fetchedAt));
  const asOf = formatDate(provenance.asOf ?? fallbackAsOf);
  element.textContent = `${label}: ${provenance.isMock ? 'DỮ LIỆU MẪU' : provenance.source.toUpperCase()}`
    + (asOf ? ` · ngày dữ liệu ${asOf}` : ' · ngày dữ liệu chưa rõ')
    + ` · nhận lúc ${received}`;
  element.classList.toggle('is-mock', provenance.isMock);
}
