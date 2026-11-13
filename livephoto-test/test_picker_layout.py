"""用真实 Chromium 验证图片选择器布局，无需启动本地服务。
运行：python test_picker_layout.py [--screenshot 文件路径]
依赖：playwright 和本机 Google Chrome。
"""
import argparse
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--screenshot', type=Path)
parser.add_argument('--media-only', action='store_true')
parser.add_argument('--content-script', type=Path, default=ROOT / 'extension/content.js')
args = parser.parse_args()
SIZES = [(1080, 1440), (1600, 900), (1290, 1290), (900, 1800), (1800, 600)]
COLORS = ['#bfd6cb', '#c8d6ec', '#ead5bc', '#d4c9e2', '#e4bfb9']


def image_response(route):
    index = int(route.request.url.rsplit('/', 1)[1].split('.')[0])
    width, height = SIZES[index % len(SIZES)]
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}">
      <rect width="100%" height="100%" fill="{COLORS[index % len(COLORS)]}"/>
      <circle cx="{width / 2}" cy="{height / 2}" r="{min(width, height) / 4}" fill="white" opacity=".35"/>
      <text x="50%" y="46%" text-anchor="middle" font-family="sans-serif" font-size="70" fill="#334155">{index + 1:02d}</text>
      <text x="50%" y="57%" text-anchor="middle" font-family="sans-serif" font-size="42" fill="#334155">{width} × {height}</text>
    </svg>'''
    route.fulfill(status=200, content_type='image/svg+xml', body=svg)


MEASURE = """() => {
    const root = document.querySelector('#sgp-picker-host').shadowRoot;
    const rect = el => { const r = el.getBoundingClientRect();
        return {left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height}; };
    return {
        cards: [...root.querySelectorAll('.sgp-card')].map(card => ({
            ...rect(card), image:rect(card.querySelector('.sgp-thumb')), meta:rect(card.querySelector('.sgp-meta')),
            ratio: Number(card.querySelector('.sgp-thumb').style.aspectRatio.split('/')[0]) /
                Number(card.querySelector('.sgp-thumb').style.aspectRatio.split('/')[1])
        })),
        head:rect(root.querySelector('.sgp-head')), foot:rect(root.querySelector('.sgp-foot')),
        panel:rect(root.querySelector('.sgp-panel')),
        count:root.querySelector('.sgp-count').textContent
    };
}"""


def verify_layout(page, count):
    data = page.evaluate(MEASURE)
    cards = data['cards']
    assert len(cards) == count
    for i, card in enumerate(cards):
        image, meta = card['image'], card['meta']
        assert abs(image['width'] / image['height'] - card['ratio']) < .02, f'图片 {i} 比例失真'
        assert meta['top'] >= image['bottom'] - 1, f'图片 {i} 覆盖尺寸栏'
        assert meta['bottom'] <= card['bottom'] + 1, f'图片 {i} 尺寸栏超出卡片'
        for other in cards[i + 1:]:
            overlap_x = min(card['right'], other['right']) - max(card['left'], other['left'])
            overlap_y = min(card['bottom'], other['bottom']) - max(card['top'], other['top'])
            assert overlap_x <= 1 or overlap_y <= 1, f'卡片 {i} 与后续卡片重叠'
    viewport = page.viewport_size
    assert data['panel']['left'] >= 0 and data['panel']['right'] <= viewport['width'] + 1
    assert data['head']['top'] >= 0 and data['foot']['bottom'] <= viewport['height'] + 1
    assert data['foot']['height'] >= 40, '底栏被压缩'
    return data


with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    try:
        for count in (() if args.media_only else (1, 19, 60)):
            page = browser.new_page(viewport={'width': 1280, 'height': 900})
            page.route('https://picker.test/images/*', image_response)
            page.set_content('<body style="margin:0;background:#edf0f3"><main>' + ''.join(
                f'<img style="width:100px" src="https://picker.test/images/{i}.svg">' for i in range(count)
            ) + '</main></body>')
            page.wait_for_function('Array.from(document.images).every(img => img.complete && img.naturalWidth)')
            page.evaluate('''() => {
                window.chrome = { runtime: {
                    onMessage: {addListener(fn) { window.pickerMessage = fn; }},
                    sendMessage(message) { window.savedMessage = message; return Promise.resolve(); }
                }};
            }''')
            page.add_script_tag(path=str(args.content_script))
            page.evaluate("window.pickerMessage({action:'openPicker'}, {}, () => {})")
            page.locator('.sgp-card').first.wait_for()
            for width, height in ((1280, 900), (960, 640), (390, 700)):
                page.set_viewport_size({'width': width, 'height': height})
                verify_layout(page, count)
                print(f'PASS {count} 张图片，窗口 {width} × {height}：无重叠、等比、尺寸栏完整')
            page.set_viewport_size({'width': 1280, 'height': 900})
            scroll = page.locator('.sgp-scroll')
            if scroll.count():
                scroll.evaluate('(el) => { el.scrollTop = el.scrollHeight; }')
            else:
                page.locator('.sgp-grid').evaluate('(el) => { el.scrollTop = el.scrollHeight; }')
            after_scroll = verify_layout(page, count)
            last = after_scroll['cards'][-1]
            assert last['meta']['bottom'] <= after_scroll['foot']['top'] + 1, '最后一张尺寸栏无法滚动到可见区域'
            page.get_by_role('button', name='Select none', exact=True).click()
            assert page.get_by_role('button', name='Save', exact=True).is_disabled()
            page.locator('.sgp-card').first.click()
            assert page.locator('.sgp-count').inner_text() == f'1 of {count} selected'
            page.get_by_role('button', name='Select all', exact=True).click()
            assert page.locator('.sgp-count').inner_text() == f'{count} of {count} selected'
            if count == 19 and args.screenshot:
                page.locator('.sgp-scroll').evaluate('(el) => { el.scrollTop = 0; }')
                args.screenshot.parent.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(args.screenshot))
            page.get_by_role('button', name=f'Save {count}', exact=True).click()
            assert page.locator('#sgp-picker-host').count() == 0
            assert page.evaluate('window.savedMessage.items.length') == count
            print(f'PASS {count} 张图片：滚动到底、全选、取消选择、保存选择结果')
            page.close()

        # 混合媒体：已知时长、未知时长、无封面、blob 和分段流。
        page = browser.new_page(viewport={'width': 1280, 'height': 900})
        page.route('https://picker.test/images/*', image_response)
        media_requests = []
        def video_response(route):
            media_requests.append(route.request.url)
            route.fulfill(status=200, content_type='video/mp4', path=str(ROOT / 'livephoto-test/page/clip.mp4'))
        page.route('https://picker.test/videos/*', video_response)
        page.set_content('<body style="margin:0;background:#edf0f3"><main></main></body>')
        page.evaluate('''() => {
            const clips = [
                ['short.mp4', 3, true], ['boundary.mp4', 10, true],
                ['long.mp4', 32, true], ['unknown.mp4', NaN, true],
                ['nocover.mp4', 3, false], ['blob:fixture', 3, true],
                ['stream.m3u8', 32, true]
            ];
            clips.forEach(([name, duration, cover], index) => {
                let parent = document.querySelector('main');
                // 无封面视频与其它图片隔开，避免触发旧的邻近封面查找规则。
                for (let depth = 0; depth < 6; depth++) {
                    parent = parent.appendChild(document.createElement('div'));
                }
                const video = document.createElement('video');
                video.src = name.startsWith('blob:') ? name : 'https://picker.test/videos/' + name;
                video.preload = 'none';
                if (cover) video.poster = 'https://picker.test/images/' + index + '.svg';
                Object.defineProperties(video, {
                    duration: {value:duration}, videoWidth: {value:1280}, videoHeight: {value:720}
                });
                parent.appendChild(video);
            });
            const image = document.createElement('img');
            image.src = 'https://picker.test/images/20.svg';
            document.querySelector('main').appendChild(image);
            window.chrome = { runtime: {
                onMessage: {addListener(fn) {window.pickerMessage = fn;}},
                sendMessage(message) {
                    if (message.action === 'saveSelectedItems') window.savedMessage = message;
                    return Promise.resolve();
                }
            }};
        }''')
        page.wait_for_function('Array.from(document.images).every(img => img.complete && img.naturalWidth)')
        page.add_script_tag(path=str(args.content_script))
        page.evaluate("window.pickerMessage({action:'openPicker'}, {}, () => {})")
        assert page.locator('.sgp-kind').all_text_contents().count('Live Photo') == 4
        assert page.locator('.sgp-kind').all_text_contents().count('Video') == 3
        # 只剩 m3u8 不可选；blob 动态段的 Live Photo 现在可勾选
        assert page.locator('.sgp-card input:disabled').count() == 1
        assert page.locator('.sgp-card input:checked').count() == 7
        assert not media_requests, '打开面板不应下载视频'
        for width, height in ((1280, 900), (390, 700)):
            page.set_viewport_size({'width': width, 'height': height})
            verify_layout(page, 8)
        page.set_viewport_size({'width': 1280, 'height': 900})
        page.get_by_role('button', name='Select none', exact=True).click()
        page.get_by_role('button', name='Select all', exact=True).click()
        assert page.locator('.sgp-card input:checked').count() == 7
        if args.screenshot:
            page.locator('.sgp-scroll').evaluate('(el) => {el.scrollTop = 0;}')
            page.screenshot(path=str(args.screenshot.with_name('picker-media-fixed.png')))
        # 点击预览入口，验证浏览器确实能解码视频并保持勾选状态。
        unknown = page.locator('.sgp-card').filter(has=page.locator('video[src$="unknown.mp4"]'))
        preview = unknown.locator('video')
        unknown.get_by_role('button', name='Preview video').click()
        page.wait_for_function('''() => {
            const root = document.querySelector('#sgp-picker-host').shadowRoot;
            return root.querySelector('video[src$="unknown.mp4"]').readyState >= 2;
        }''')
        assert unknown.locator('input').is_checked()
        assert unknown.locator('.sgp-duration').inner_text() != 'Duration unknown'
        preview.evaluate('(el) => el.pause()')
        # 用 metadata 事件覆盖“先未知，随后发现是长视频”的类型同步分支。
        preview.evaluate('''el => {
            Object.defineProperty(el, 'duration', {value:32});
            el.dispatchEvent(new Event('loadedmetadata'));
        }''')
        assert unknown.locator('.sgp-kind').inner_text() == 'Video'
        assert unknown.locator('.sgp-duration').inner_text() == '0:32'
        page.get_by_role('button', name='Save 7', exact=True).click()
        saved = page.evaluate('window.savedMessage.items')
        assert len(saved) == 7
        assert next(item for item in saved if item['url'].endswith('unknown.mp4'))['kind'] == 'video'
        assert sum(item['kind'] == 'live' for item in saved) == 3
        assert not any(item.get('unavailableReason') for item in saved)
        print('PASS 混合媒体真实布局、类型/时长、不可选项、按需视频预览和保存快照')
        page.close()
    finally:
        browser.close()
