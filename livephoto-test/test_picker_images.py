"""在真实 Chrome 中验证预览请求策略、地址回退及失败提示，无需外网或本地服务。"""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200"><rect width="900" height="1200" fill="green"/></svg>'

with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    try:
        for mode in ('inherit', 'retry', 'fallback', 'failure'):
            page = browser.new_page()
            # 页面图片已经解码过一次，面板用同一地址会命中内存缓存，
            # 请求不经过网络就看不到 Referer 策略。测试必须禁用缓存。
            cdp = page.context.new_cdp_session(page)
            cdp.send('Network.enable')
            cdp.send('Network.setCacheDisabled', {'cacheDisabled': True})
            requests = []
            phase = {'picker': False}

            def respond(route):
                request = route.request
                if request.url == 'https://www.xiaohongshu.com/explore':
                    policy = 'referrerpolicy="no-referrer"' if mode == 'inherit' else ''
                    # 宽高属性保证页面图片即使加载失败也能通过选择器的尺寸门槛
                    route.fulfill(content_type='text/html', body=(
                        f'<img {policy} width="900" height="1200" '
                        'src="https://sns-webpic-qc.xhscdn.com/test.jpg!preview">'))
                    return
                referer = request.headers.get('referer', '')
                if not phase['picker']:
                    # 页面阶段一律失败：成功的图片会被解码缓存，面板用同一地址
                    # 就不再发请求，无法观察 Referer 策略。
                    route.fulfill(status=403, content_type='text/plain',
                                  headers={'Cache-Control': 'no-store'}, body='Forbidden')
                    return
                requests.append((request.url, referer))
                allowed = (mode in ('inherit', 'retry') and not referer) or (
                    mode == 'fallback' and 'sns-img-qc.' in request.url)
                route.fulfill(status=200 if allowed else 403,
                              content_type='image/svg+xml' if allowed else 'text/plain',
                              headers={'Cache-Control': 'no-store'}, body=SVG if allowed else 'Forbidden')

            page.route('**/*', respond)
            page.goto('https://www.xiaohongshu.com/explore', wait_until='networkidle')
            page.wait_for_function('document.images[0].complete')
            phase['picker'] = True
            page.evaluate('''() => {
                window.chrome = { runtime: {
                    onMessage: {addListener(fn) {window.pickerMessage = fn;}},
                    sendMessage(message) {window.savedMessage = message; return Promise.resolve();}
                }};
            }''')
            page.add_script_tag(path=str(ROOT / 'extension/content.js'))
            page.evaluate("window.pickerMessage({action:'openPicker'}, {}, () => {})")
            thumb = page.locator('.sgp-thumb')
            if mode == 'inherit':
                assert thumb.evaluate('(el) => el.referrerPolicy') == 'no-referrer', '没有继承来源图片的请求策略'
            if mode == 'failure':
                page.get_by_text('Preview unavailable. You can still select and save this image.', exact=True).wait_for()
                assert not thumb.get_attribute('src'), '失败后应移除破图地址'
                assert 1 <= len(requests) <= 8, '回退必须有界'
            else:
                page.wait_for_function('''() => {
                    const img = document.querySelector('#sgp-picker-host').shadowRoot.querySelector('img');
                    return img.complete && img.naturalWidth === 900;
                }''')
                if mode == 'retry':
                    assert any(ref for _, ref in requests), '应先使用原有策略'
                    assert any(not ref for _, ref in requests), '失败后应尝试不发送 Referer'
                    assert all('!preview' in url for url, _ in requests), '应先重试原预览地址'
                if mode == 'fallback':
                    assert 'sns-img-qc.' in thumb.get_attribute('src'), '应继续尝试备用地址'
            assert page.locator('.sgp-card input').is_checked(), '预览失败不能改变勾选状态'
            page.get_by_role('button', name='Save 1', exact=True).click()
            saved = page.evaluate('window.savedMessage.items[0]')
            assert saved['url'] == 'https://sns-img-qc.xhscdn.com/test.jpg', '预览回退不能改写保存地址'
            print(f'PASS 图片预览 {mode}，请求数 {len(requests)}，勾选与保存地址不变')
            page.close()
    finally:
        browser.close()
