"""Vercel serverless function: /api/news
Fetches news from TCBS API + RSS feeds (CafeF, VnExpress) with Vietnamese sentiment analysis.
"""
from http.server import BaseHTTPRequestHandler
import json
import warnings
import time
import hashlib
warnings.filterwarnings('ignore')

import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _cache import cache_get, cache_set

# ===========================
# Vietnamese Sentiment Dictionary
# ===========================
POSITIVE_WORDS = [
    'tăng', 'tăng trưởng', 'tăng mạnh', 'tăng vốn', 'tăng giá',
    'lợi nhuận', 'lãi', 'lãi lớn', 'lãi ròng', 'lãi kỷ lục',
    'cổ tức', 'chia cổ tức', 'trả cổ tức',
    'mua ròng', 'khối ngoại mua', 'nước ngoài mua',
    'đột phá', 'kỷ lục', 'cao nhất', 'đỉnh mới', 'vượt đỉnh',
    'tích cực', 'khả quan', 'triển vọng', 'tiềm năng',
    'phục hồi', 'hồi phục', 'bật tăng', 'đảo chiều tăng',
    'khuyến nghị mua', 'mục tiêu tăng', 'nâng mục tiêu',
    'doanh thu tăng', 'xuất khẩu tăng', 'đơn hàng tăng',
    'thắng thầu', 'ký hợp đồng', 'hợp tác', 'mở rộng',
    'thưởng cổ phiếu', 'phát hành', 'niêm yết',
    'vượt kỳ vọng', 'beat', 'outperform',
]

NEGATIVE_WORDS = [
    'giảm', 'giảm mạnh', 'giảm sâu', 'giảm giá', 'sụt giảm',
    'thua lỗ', 'lỗ', 'lỗ ròng', 'lỗ nặng', 'thua lỗ kỷ lục',
    'nợ', 'nợ xấu', 'nợ tăng', 'vỡ nợ',
    'bán ròng', 'khối ngoại bán', 'nước ngoài bán', 'xả hàng',
    'phạt', 'vi phạm', 'xử phạt', 'bị phạt',
    'cảnh báo', 'rủi ro', 'nguy cơ', 'mất an toàn',
    'thoái vốn', 'rút vốn', 'cắt giảm',
    'khuyến nghị bán', 'hạ mục tiêu', 'downgrade',
    'phá sản', 'giải thể', 'đình chỉ', 'hủy niêm yết',
    'trần', 'sàn', 'bán tháo', 'panic',
    'lạm phát', 'suy thoái', 'khủng hoảng',
    'điều tra', 'thanh tra', 'kiểm tra',
    'trì hoãn', 'chậm tiến độ', 'đội vốn',
]

EVENT_KEYWORDS = {
    'EARNINGS': ['lợi nhuận', 'doanh thu', 'kết quả kinh doanh', 'báo cáo tài chính', 'quý', 'lãi ròng', 'lỗ ròng', 'BCTC'],
    'DIVIDEND': ['cổ tức', 'chia cổ tức', 'trả cổ tức', 'ngày chốt', 'thưởng cổ phiếu'],
    'M&A': ['sáp nhập', 'mua lại', 'thâu tóm', 'hợp nhất', 'M&A', 'chào mua'],
    'INSIDER': ['cổ đông lớn', 'nội bộ', 'mua vào', 'bán ra', 'giao dịch nội bộ', 'HĐQT', 'ban lãnh đạo'],
    'REGULATION': ['nghị định', 'thông tư', 'quy định', 'luật', 'chính sách', 'NHNN', 'SBV', 'thuế'],
    'INDUSTRY': ['ngành', 'lĩnh vực', 'thị trường', 'cạnh tranh', 'thị phần'],
    'MARKET': ['VN-Index', 'VNINDEX', 'thị trường chung', 'thanh khoản', 'dòng tiền', 'vốn hóa'],
}

# Company name mapping for ticker detection in RSS articles
TICKER_NAMES = {
    'FPT': ['FPT', 'fpt'],
    'VNM': ['Vinamilk', 'VNM', 'sữa Việt Nam'],
    'VIC': ['Vingroup', 'VIC', 'Vin'],
    'HPG': ['Hòa Phát', 'HPG', 'Hoa Phat'],
    'MWG': ['Thế Giới Di Động', 'MWG', 'Mobile World'],
    'TCB': ['Techcombank', 'TCB'],
    'VHM': ['Vinhomes', 'VHM'],
    'MSN': ['Masan', 'MSN'],
    'VCB': ['Vietcombank', 'VCB'],
    'ACB': ['ACB'],
    'SSI': ['SSI'],
    'VPB': ['VPBank', 'VPB'],
    'STB': ['Sacombank', 'STB'],
    'GAS': ['PV Gas', 'GAS', 'PVGas'],
    'PLX': ['Petrolimex', 'PLX'],
    'MBB': ['MB Bank', 'MBB', 'MB'],
    'CTG': ['VietinBank', 'CTG', 'Vietin'],
    'DGC': ['Đức Giang', 'DGC'],
    'PNJ': ['PNJ', 'Phú Nhuận'],
    'REE': ['REE'],
}


def analyze_sentiment(text):
    """Score sentiment of Vietnamese text. Returns -100 to +100."""
    if not text:
        return 0
    text_lower = text.lower()
    pos_count = sum(1 for w in POSITIVE_WORDS if w.lower() in text_lower)
    neg_count = sum(1 for w in NEGATIVE_WORDS if w.lower() in text_lower)
    total = pos_count + neg_count
    if total == 0:
        return 0
    raw = (pos_count - neg_count) / total
    return int(raw * 100)


def classify_event(text):
    """Classify news event type based on keywords."""
    if not text:
        return 'MARKET'
    text_lower = text.lower()
    for event_type, keywords in EVENT_KEYWORDS.items():
        for kw in keywords:
            if kw.lower() in text_lower:
                return event_type
    return 'MARKET'


def detect_tickers(text):
    """Find related tickers from article text."""
    if not text:
        return []
    found = []
    for ticker, names in TICKER_NAMES.items():
        for name in names:
            if name in text:
                found.append(ticker)
                break
    return found


def fetch_tcbs_news(ticker):
    """Try to fetch news from TCBS API for a specific ticker, cached for 120s."""
    cache_key = f"tcbs_news:{ticker}"
    cached = cache_get(cache_key)
    if cached is not None:
        return cached
    try:
        import requests as req
        # Try activity-news endpoint
        resp = req.get(
            f"https://apipubaws.tcbs.com.vn/tcanalysis/v1/ticker/{ticker}/activity-news",
            timeout=10,
            headers={"Accept": "application/json"}
        )
        if resp.status_code == 200:
            data = resp.json()
            articles = []
            items = data if isinstance(data, list) else data.get('listActivityNews', data.get('data', []))
            for item in items[:10]:
                title = item.get('title', item.get('headline', ''))
                summary = item.get('content', item.get('summary', item.get('description', '')))
                pub_date = item.get('publishDate', item.get('date', item.get('time', '')))
                url = item.get('url', item.get('link', ''))
                full_text = f"{title} {summary}"
                sentiment = analyze_sentiment(full_text)

                articles.append({
                    'title': title,
                    'summary': summary[:200] if summary else '',
                    'url': url,
                    'source': 'TCBS',
                    'publishedAt': str(pub_date)[:19] if pub_date else '',
                    'sentiment': sentiment,
                    'sentimentLabel': 'positive' if sentiment > 15 else ('negative' if sentiment < -15 else 'neutral'),
                    'eventType': classify_event(full_text),
                    'relatedTickers': [ticker],
                })
            cache_set(cache_key, articles, ttl=120)
            return articles
    except Exception:
        pass
    return []


def fetch_rss_news():
    """Fetch and parse RSS feeds from CafeF and VnExpress, cached for 120s."""
    cached = cache_get('rss_news')
    if cached is not None:
        return cached
    articles = []
    feeds = [
        ('https://cafef.vn/rss/thi-truong-chung-khoan.rss', 'CafeF'),
        ('https://cafef.vn/rss/doanh-nghiep.rss', 'CafeF'),
        ('https://vnexpress.net/rss/kinh-doanh/chung-khoan.rss', 'VnExpress'),
    ]

    try:
        import requests as req
        from bs4 import BeautifulSoup

        for feed_url, source_name in feeds:
            try:
                resp = req.get(feed_url, timeout=8, headers={
                    'User-Agent': 'Mozilla/5.0 (compatible; TraderAI/1.0)'
                })
                if resp.status_code != 200:
                    continue
                soup = BeautifulSoup(resp.content, 'lxml-xml')
                items = soup.find_all('item')

                for item in items[:8]:
                    title = item.find('title')
                    title = title.get_text(strip=True) if title else ''
                    desc = item.find('description')
                    desc = desc.get_text(strip=True) if desc else ''
                    link = item.find('link')
                    link = link.get_text(strip=True) if link else ''
                    pub = item.find('pubDate')
                    pub = pub.get_text(strip=True) if pub else ''

                    full_text = f"{title} {desc}"
                    sentiment = analyze_sentiment(full_text)
                    tickers = detect_tickers(full_text)

                    articles.append({
                        'title': title,
                        'summary': desc[:200] if desc else '',
                        'url': link,
                        'source': source_name,
                        'publishedAt': pub[:25] if pub else '',
                        'sentiment': sentiment,
                        'sentimentLabel': 'positive' if sentiment > 15 else ('negative' if sentiment < -15 else 'neutral'),
                        'eventType': classify_event(full_text),
                        'relatedTickers': tickers,
                    })
            except Exception:
                continue
    except Exception:
        pass

    if articles:
        cache_set('rss_news', articles, ttl=120)
    return articles


def aggregate_sentiment(articles, ticker=None):
    """Aggregate sentiment from articles, optionally filtered by ticker."""
    if ticker:
        relevant = [a for a in articles if ticker in a.get('relatedTickers', [])]
        if not relevant:
            relevant = articles  # fallback to all if no ticker match
    else:
        relevant = articles

    if not relevant:
        return {
            'overall': 0, 'label': 'neutral',
            'articleCount': 0, 'positiveCount': 0, 'negativeCount': 0, 'neutralCount': 0,
            'trend': 'STABLE', 'keyEvents': [],
        }

    # Recency-weighted: newer articles get more weight
    total_weight = 0
    weighted_sum = 0
    for i, art in enumerate(relevant):
        weight = 1.0 + (i * 0.1)  # newer articles first = higher weight
        weighted_sum += art['sentiment'] * weight
        total_weight += weight

    overall = int(weighted_sum / total_weight) if total_weight > 0 else 0
    pos = sum(1 for a in relevant if a['sentiment'] > 15)
    neg = sum(1 for a in relevant if a['sentiment'] < -15)
    neu = len(relevant) - pos - neg

    # Trend: compare sentiment of first half vs second half
    mid = len(relevant) // 2
    if mid > 0:
        first_avg = sum(a['sentiment'] for a in relevant[:mid]) / mid
        second_avg = sum(a['sentiment'] for a in relevant[mid:]) / (len(relevant) - mid)
        if second_avg > first_avg + 10:
            trend = 'IMPROVING'
        elif second_avg < first_avg - 10:
            trend = 'WORSENING'
        else:
            trend = 'STABLE'
    else:
        trend = 'STABLE'

    # Key events
    events = list(set(a['eventType'] for a in relevant if a['eventType'] != 'MARKET'))

    label = 'positive' if overall > 15 else ('negative' if overall < -15 else 'neutral')

    return {
        'overall': overall, 'label': label,
        'articleCount': len(relevant),
        'positiveCount': pos, 'negativeCount': neg, 'neutralCount': neu,
        'trend': trend, 'keyEvents': events[:5],
    }


def get_mock_news(ticker=None):
    """Generate realistic mock Vietnamese news articles."""
    mock_articles = [
        {'title': 'VN-Index vượt mốc 1.260 điểm, thanh khoản đạt kỷ lục', 'summary': 'Thị trường chứng khoán Việt Nam phiên hôm nay ghi nhận đà tăng mạnh với VN-Index vượt mốc 1.260 điểm. Thanh khoản toàn thị trường đạt hơn 28.000 tỷ đồng.', 'source': 'CafeF', 'sentiment': 65, 'eventType': 'MARKET', 'relatedTickers': []},
        {'title': 'FPT báo lãi ròng quý 4 tăng 22% so với cùng kỳ', 'summary': 'FPT Corporation công bố kết quả kinh doanh quý 4 với lợi nhuận ròng đạt 2.100 tỷ đồng, tăng 22% so với cùng kỳ năm trước nhờ mảng CNTT và viễn thông.', 'source': 'VnExpress', 'sentiment': 72, 'eventType': 'EARNINGS', 'relatedTickers': ['FPT']},
        {'title': 'Khối ngoại bán ròng hơn 500 tỷ đồng trên sàn HOSE', 'summary': 'Khối ngoại tiếp tục bán ròng mạnh trên thị trường chứng khoán với giá trị hơn 500 tỷ đồng, tập trung vào nhóm ngân hàng và bất động sản.', 'source': 'CafeF', 'sentiment': -45, 'eventType': 'MARKET', 'relatedTickers': ['VCB', 'TCB', 'VIC']},
        {'title': 'HPG: Sản lượng thép tháng 3 tăng mạnh 35%', 'summary': 'Hòa Phát ghi nhận sản lượng thép xây dựng và thép cuộn cán nóng tháng 3 đạt kỷ lục, tăng 35% so với cùng kỳ. Xuất khẩu chiếm tỷ trọng cao.', 'source': 'VnExpress', 'sentiment': 58, 'eventType': 'EARNINGS', 'relatedTickers': ['HPG']},
        {'title': 'Vingroup ký hợp đồng hợp tác chiến lược với đối tác Nhật Bản', 'summary': 'Tập đoàn Vingroup vừa ký kết thỏa thuận hợp tác chiến lược với một tập đoàn lớn của Nhật Bản trong lĩnh vực công nghệ và xe điện.', 'source': 'CafeF', 'sentiment': 48, 'eventType': 'M&A', 'relatedTickers': ['VIC']},
        {'title': 'NHNN giữ nguyên lãi suất điều hành, hỗ trợ tăng trưởng', 'summary': 'Ngân hàng Nhà nước quyết định giữ nguyên các mức lãi suất điều hành nhằm hỗ trợ tăng trưởng kinh tế và thanh khoản thị trường.', 'source': 'VnExpress', 'sentiment': 35, 'eventType': 'REGULATION', 'relatedTickers': ['VCB', 'TCB', 'ACB', 'VPB', 'STB', 'MBB', 'CTG']},
        {'title': 'MWG: Bách Hóa Xanh lần đầu có lãi, doanh thu vượt kỳ vọng', 'summary': 'Chuỗi Bách Hóa Xanh thuộc Thế Giới Di Động lần đầu tiên ghi nhận lợi nhuận dương sau nhiều năm thua lỗ. Doanh thu chuỗi tăng 25%.', 'source': 'CafeF', 'sentiment': 68, 'eventType': 'EARNINGS', 'relatedTickers': ['MWG']},
        {'title': 'Cảnh báo rủi ro nhóm cổ phiếu bất động sản', 'summary': 'Nhiều chuyên gia cảnh báo rủi ro với nhóm cổ phiếu bất động sản do áp lực trái phiếu đáo hạn và dòng tiền yếu tại một số doanh nghiệp.', 'source': 'VnExpress', 'sentiment': -52, 'eventType': 'INDUSTRY', 'relatedTickers': ['VIC', 'VHM']},
        {'title': 'VNM chia cổ tức tiền mặt 2.000 đồng/cp, tỷ suất hấp dẫn', 'summary': 'Vinamilk thông báo chia cổ tức tiền mặt đợt 2 năm 2025 với mức 2.000 đồng/cổ phiếu. Ngày chốt danh sách cổ đông ngày 15/4.', 'source': 'CafeF', 'sentiment': 55, 'eventType': 'DIVIDEND', 'relatedTickers': ['VNM']},
        {'title': 'Dòng tiền đổ mạnh vào nhóm chứng khoán, SSI dẫn đầu thanh khoản', 'summary': 'Nhóm cổ phiếu chứng khoán thu hút dòng tiền mạnh trong phiên giao dịch hôm nay. SSI dẫn đầu với thanh khoản hơn 1.800 tỷ đồng.', 'source': 'VnExpress', 'sentiment': 42, 'eventType': 'MARKET', 'relatedTickers': ['SSI']},
        {'title': 'PV Gas đặt mục tiêu lợi nhuận tăng 15% trong năm 2026', 'summary': 'ĐHĐCĐ thường niên PV Gas thông qua kế hoạch lợi nhuận trước thuế tăng 15%, đồng thời duy trì tỷ lệ cổ tức tiền mặt cao.', 'source': 'CafeF', 'sentiment': 50, 'eventType': 'EARNINGS', 'relatedTickers': ['GAS']},
        {'title': 'Techcombank mở rộng hệ sinh thái số, phát triển AI Banking', 'summary': 'TCB đầu tư mạnh vào công nghệ AI và dữ liệu lớn để nâng cao trải nghiệm khách hàng, hướng tới mục tiêu ngân hàng số hàng đầu.', 'source': 'VnExpress', 'sentiment': 38, 'eventType': 'INDUSTRY', 'relatedTickers': ['TCB']},
        {'title': 'Sacombank hoàn tất xử lý nợ xấu, ROE cải thiện rõ rệt', 'summary': 'STB đã cơ bản hoàn thành xử lý các khoản nợ xấu tồn đọng. ROE ngân hàng cải thiện đáng kể so với giai đoạn trước.', 'source': 'CafeF', 'sentiment': 45, 'eventType': 'EARNINGS', 'relatedTickers': ['STB']},
        {'title': 'Petrolimex cảnh báo lợi nhuận quý 1 giảm do giá dầu', 'summary': 'PLX dự báo kết quả kinh doanh quý 1/2026 sẽ giảm so với cùng kỳ do biến động giá dầu thế giới và chi phí vận hành tăng.', 'source': 'VnExpress', 'sentiment': -38, 'eventType': 'EARNINGS', 'relatedTickers': ['PLX']},
        {'title': 'VPBank phát hành trái phiếu quốc tế 500 triệu USD', 'summary': 'VPB thành công phát hành trái phiếu quốc tế trị giá 500 triệu USD, lãi suất cạnh tranh, cho thấy uy tín trên thị trường quốc tế.', 'source': 'CafeF', 'sentiment': 40, 'eventType': 'INDUSTRY', 'relatedTickers': ['VPB']},
    ]

    # Add timestamps
    import time as t
    now = t.time()
    for i, art in enumerate(mock_articles):
        art['url'] = f"https://example.com/news/{i}"
        art['publishedAt'] = t.strftime('%Y-%m-%dT%H:%M:%S', t.localtime(now - i * 3600))
        art['sentimentLabel'] = 'positive' if art['sentiment'] > 15 else ('negative' if art['sentiment'] < -15 else 'neutral')

    if ticker:
        # Put ticker-specific articles first
        ticker_arts = [a for a in mock_articles if ticker in a.get('relatedTickers', [])]
        other_arts = [a for a in mock_articles if ticker not in a.get('relatedTickers', [])]
        result = ticker_arts + other_arts
    else:
        result = mock_articles

    return result[:12]


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        from urllib.parse import parse_qs, urlparse
        params = parse_qs(urlparse(self.path).query)

        action = params.get('action', [None])[0]
        ticker = params.get('ticker', [None])[0]
        tickers_param = params.get('tickers', [None])[0]

        articles = []
        source = 'mock'

        try:
            if action == 'market' or (not ticker and not tickers_param):
                # Market-wide news from RSS
                rss_articles = fetch_rss_news()
                if rss_articles:
                    articles = rss_articles
                    source = 'rss'
                else:
                    articles = get_mock_news()
                    source = 'mock'

            elif tickers_param:
                # Batch: multiple tickers
                ticker_list = [t.strip() for t in tickers_param.split(',')]
                # Get TCBS news for each + RSS
                for t in ticker_list[:5]:
                    tcbs = fetch_tcbs_news(t)
                    articles.extend(tcbs)
                rss = fetch_rss_news()
                articles.extend(rss)
                if articles:
                    source = 'tcbs+rss'
                else:
                    articles = get_mock_news()
                    source = 'mock'

            elif ticker:
                # Single ticker
                tcbs = fetch_tcbs_news(ticker)
                rss = fetch_rss_news()
                # Filter RSS by ticker
                rss_filtered = [a for a in rss if ticker in a.get('relatedTickers', [])]
                articles = tcbs + rss_filtered + [a for a in rss if ticker not in a.get('relatedTickers', [])]
                if articles:
                    source = 'tcbs+rss' if tcbs else 'rss'
                else:
                    articles = get_mock_news(ticker)
                    source = 'mock'

        except Exception:
            articles = get_mock_news(ticker)
            source = 'mock'

        # Deduplicate by title hash
        seen = set()
        unique = []
        for a in articles:
            h = hashlib.md5(a.get('title', '').encode()).hexdigest()[:12]
            if h not in seen:
                seen.add(h)
                unique.append(a)
        articles = unique[:15]

        # Aggregate sentiment
        sentiment = aggregate_sentiment(articles, ticker)

        result = {
            'articles': articles,
            'sentiment': sentiment,
            'source': source,
        }

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(result, ensure_ascii=False).encode('utf-8'))
