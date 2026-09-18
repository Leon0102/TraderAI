import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatMarkdownText } from './agentCouncil';
import { streamAgentCouncil } from '../api/stockApi';
import type { AgentCouncilEvent } from '../api/stockApi';

describe('formatMarkdownText', () => {
  it('escapes HTML from untrusted LLM output', () => {
    const out = formatMarkdownText('<img src=x onerror=alert(1)> **MUA**');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
    expect(out).toContain('<strong>MUA</strong>');
  });

  it('renders bullets and line breaks', () => {
    expect(formatMarkdownText('- một\n- hai')).toBe('• một<br/>• hai');
  });
});

describe('streamAgentCouncil', () => {
  afterEach(() => vi.unstubAllGlobals());

  function mockStream(chunks: string[], status = 200) {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach(c => controller.enqueue(encoder.encode(c)));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('parses SSE frames split across chunks and stops at [DONE]', async () => {
    const fetchMock = mockStream([
      'data: {"type":"status","mess',
      'age":"Đang thu thập"}\n\ndata: {"type":"agent_start","agent":"technical","name":"Kỹ thuật"}\n\n',
      'data: [DONE]\n\ndata: {"type":"status","message":"after done"}\n\n',
    ]);

    const events: AgentCouncilEvent[] = [];
    await streamAgentCouncil({ ticker: 'HPG', apiKey: 'secret' }, e => events.push(e));

    expect(events.map(e => e.type)).toEqual(['status', 'agent_start']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/agents/stream');
    expect(init.method).toBe('POST');
    expect(url).not.toContain('secret'); // key travels in the body, not the URL
    expect(JSON.parse(init.body).apiKey).toBe('secret');
  });

  it('throws the server error detail on non-2xx responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: 'Mã cổ phiếu không hợp lệ' }), { status: 400 }))
    );
    await expect(streamAgentCouncil({ ticker: '??' }, () => {})).rejects.toThrow('Mã cổ phiếu không hợp lệ');
  });
});

describe('Council Sectors and Verdict Storage', () => {
  it('exports valid sector definitions with expected industry tickers', async () => {
    const { SECTORS } = await import('./agentCouncil');
    expect(SECTORS.length).toBeGreaterThanOrEqual(7);
    const bank = SECTORS.find(s => s.id === 'BANK');
    expect(bank).toBeDefined();
    expect(bank?.tickers).toContain('VCB');
    expect(bank?.tickers).toContain('TCB');

    const steel = SECTORS.find(s => s.id === 'STEEL');
    expect(steel).toBeDefined();
    expect(steel?.tickers).toContain('HPG');
  });

  it('persists council verdict to localStorage and retrieves it', async () => {
    const memoryStore: Record<string, string> = {};
    const mockStorage = {
      getItem: (k: string) => memoryStore[k] || null,
      setItem: (k: string, v: string) => { memoryStore[k] = v; },
      removeItem: (k: string) => { delete memoryStore[k]; },
      clear: () => { for (const k in memoryStore) delete memoryStore[k]; },
    };
    vi.stubGlobal('localStorage', mockStorage);

    const { saveCouncilVerdict, getCouncilVerdict } = await import('./agentCouncil');
    const mockVerdict = {
      action: 'MUA' as const,
      entry_zone: '21.000 - 21.500 đ',
      target_price: '24.000 đ',
      stop_loss: '20.000 đ',
      sizing: '15%',
      risk_level: 'Trung bình',
      summary: 'Dòng tiền vào mạnh, RSI tích lũy tốt.',
    };

    saveCouncilVerdict('HPG', mockVerdict);
    const retrieved = getCouncilVerdict('HPG');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.action).toBe('MUA');
    expect(retrieved?.target_price).toBe('24.000 đ');
  });
});
