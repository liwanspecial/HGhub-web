"""@brief 只记录技术状态的实机播放验收，不保存画面、标题、地址或凭据。"""
import json
import os
import re
import time
import traceback
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright, TimeoutError as BrowserTimeout

ORIGIN = os.environ.get("HGHUB_TEST_URL", "http://127.0.0.1:18093")
STEP = "initialize"


def wake_controls(page, mobile):
    """@brief 唤醒桌面闲置隐藏的控件。@param page 页面。@param mobile 手机布局。@return 无。"""
    if not mobile:
        page.mouse.move(280, 110)
        page.mouse.move(320, 140)


def wait_video(page, target):
    """@brief 等待视频解码和时间推进。@param page 页面。@param target 时间阈值。@return 技术状态。"""
    deadline = time.monotonic() + 70
    while time.monotonic() < deadline:
        result = page.evaluate("""() => {
          const v = document.querySelector('video');
          return v ? {time: v.currentTime, duration: v.duration, ready: v.readyState,
            paused: v.paused, media_error: v.error?.code ?? null, width: v.videoWidth, height: v.videoHeight} : null;
        }""")
        if result and result["ready"] >= 2 and result["time"] > target:
            return result
        page.wait_for_timeout(300)
    raise AssertionError(f"Playback did not advance: {result}")


def main():
    """@brief 验证桌面与手机布局下的真实视频解码及跳转。@return 无；失败抛异常。"""
    global STEP
    report = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True, args=["--autoplay-policy=no-user-gesture-required"])
        for mobile in (False, True):
            STEP = "mobile initial playback" if mobile else "desktop initial playback"
            context = browser.new_context(viewport={"width":390 if mobile else 1280,"height":844 if mobile else 800},
                is_mobile=mobile, has_touch=mobile,
                user_agent="Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36" if mobile else None)
            page = context.new_page()
            errors = []
            hosts = set()
            media_statuses = []
            page.on("pageerror", lambda error: errors.append(type(error).__name__))
            page.on("request", lambda request: hosts.add(urlparse(request.url).netloc) if request.url.startswith("http") else None)
            page.on("response", lambda response: media_statuses.append(response.status) if "/media/" in response.url else None)
            page.goto(ORIGIN, wait_until="domcontentloaded")
            try:
                page.wait_for_load_state("networkidle", timeout=20000)
            except BrowserTimeout:
                pass  # 持续缓冲时以解码和时间推进作为验收条件。
            initial = wait_video(page, 0.5)
            target = min(12, initial["duration"] / 2)
            page.evaluate("target => { const v=document.querySelector('video'); v.currentTime=target; void v.play(); }", target)
            sought = wait_video(page, target + 0.5)
            STEP = "author and episode selection"
            wake_controls(page, mobile)
            # 全新隔离浏览器中的本次测试记录；不读取用户浏览器数据或导出实际内容。
            author=page.get_by_role("button",name="查看博主信息",exact=True)
            expect(author).to_be_visible()
            author.click()
            expect(page.get_by_role("region",name="博主信息")).to_be_visible()
            page.get_by_role("button",name="选集",exact=True).last.click()
            episode_buttons=page.get_by_role("button",name=re.compile(r"^第 \d+ 集$"))
            expect(episode_buttons.first).to_be_visible()
            episode_count=episode_buttons.count()
            pick=episode_buttons.nth(1 if episode_count>1 else 0)
            selected_episode=pick.get_attribute("aria-label")
            pick.click();wait_video(page,0.5)
            STEP = "reload selected episode"
            page.reload(wait_until="domcontentloaded")
            refreshed=wait_video(page,0.5)
            wake_controls(page, mobile)
            expect(page.get_by_role("button",name="查看博主信息",exact=True)).to_be_visible()
            page.get_by_role("button",name="选集",exact=True).last.click()
            expect(page.get_by_role("button",name=selected_episode,exact=True)).to_have_attribute("aria-pressed","true")
            assert episode_buttons.count()==episode_count
            page.get_by_role("button",name=selected_episode,exact=True).click()
            STEP = "history navigation and reload"
            page.get_by_role("button",name="返回",exact=True).click()
            page.get_by_role("button",name="我的",exact=True).click()
            page.get_by_role("button",name="观看历史",exact=True).last.click()
            expect(page.get_by_role("button",name=re.compile("^继续观看")).first).to_be_visible()
            page.reload(wait_until="domcontentloaded")
            expect(page.get_by_role("button",name=re.compile("^继续观看")).first).to_be_visible()
            assert hosts == {urlparse(ORIGIN).netloc}, "Media request escaped the local service"
            assert not errors, errors
            report.append({"mobile":mobile,"initial":initial,"after_seek":sought,"page_errors":errors,
                           "all_http_requests_same_origin":True,"episode_count":episode_count,"author_and_history_visible":True,
                           "episode_survives_refresh":True,"after_refresh":refreshed,"media_response_count":len(media_statuses),
                           "media_error_statuses":[status for status in media_statuses if status>=400]})
            context.close()
        browser.close()
    output=os.environ.get("HGHUB_LIVE_REPORT")
    if output:
        with open(output,"w",encoding="utf-8") as stream:
            json.dump(report,stream,ensure_ascii=False,indent=2)
    print(json.dumps(report,ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Playwright 的原始异常可能包含 DOM、封面签名或媒体地址，只输出技术位置。
        print(json.dumps({"error":type(error).__name__,"step":STEP,
                          "locations":[{"function":frame.name,"line":frame.lineno}
                                       for frame in traceback.extract_tb(error.__traceback__) if frame.filename==__file__]}))
        raise SystemExit(1)
