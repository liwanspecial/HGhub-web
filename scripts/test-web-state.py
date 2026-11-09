"""@brief 用合成剧集验证刷新、历史、作者和选集恢复，不读取真实个人记录。"""
import json
import os
import re
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = os.environ.get("HGHUB_TEST_URL", "http://127.0.0.1:4173")
MEDIA = ROOT / "test-results/synthetic-media"
TITLE = "合成测试连续剧"
AUTHOR = "测试博主"
EPISODES = [{"ep_num": number, "title": f"合成第{number}集", "duration": 90, "status": 1} for number in (1,2,3)]
DETAIL = {"id":123,"title":TITLE,"cover":"","tags":["测试"],"score":9,"episode_count":3,
          "total_episodes":3,"episodes":EPISODES,"description":"合成刷新恢复测试",
          "counts":{"collect":0,"comment":0,"hot":0,"like":0},
          "author":{"id":77,"name":AUTHOR,"followers":100},"is_finished":True,"is_original":1,
          "video_url":"https://media.example.test/?auth_key=dummy-private-playback", "video_key":"dummy-private-key"}


def wait_video(page, target=0.2):
    """@brief 等待合成视频时间推进。@param page 页面。@param target 时间阈值。@return 无。"""
    deadline=time.monotonic()+30
    while not page.evaluate("target => Array.from(document.querySelectorAll('video')).some(v=>v.readyState>=2 && v.currentTime>target)",target):
        assert time.monotonic()<deadline, "Synthetic playback failed"
        page.wait_for_timeout(150)


def main():
    """@brief 验证桌面和手机的刷新恢复与元数据失败回退。@return 无；失败抛异常。"""
    reports=[]
    output=ROOT/"test-results/web-state"
    output.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as p:
        browser=p.chromium.launch(channel="msedge",headless=True,args=["--autoplay-policy=no-user-gesture-required"])
        for mobile in (False,True):
            context=browser.new_context(viewport={"width":390 if mobile else 1280,"height":844 if mobile else 800},
                is_mobile=mobile,has_touch=mobile,
                user_agent="Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36" if mobile else None)
            context.add_init_script("""if(!localStorage.getItem('hghub_app_v1')) localStorage.setItem('hghub_app_v1',JSON.stringify({likes:[],favs:[],follows:[],history:[{id:123,ep:2,t:12,dur:90,at:2},{id:124,ep:1,t:4,dur:90,at:1}],muted:true,muteOnStartup:true,volume:.7,searchHist:[]}));""")
            page=context.new_page()
            fail_details=[True]
            commands=[]
            hold_details=[False]; pending_details=[]; show_feed=[False]
            errors=[]
            page.on("pageerror",lambda error: errors.append(str(error)))

            def api(route):
                request=route.request.post_data_json; command=request['command']; args=request.get('args',{})
                commands.append((command,args))
                if command=='api_video':
                    if hold_details[0]:
                        pending_details.append((route,args));return
                    if fail_details[0]:
                        route.fulfill(status=503,content_type='application/json',body='{"error":"dummy-metadata-unavailable"}');return
                    detail={**DETAIL,'id':args['id'],'title':TITLE if args['id']==123 else '合成历史记录二'}
                    route.fulfill(status=200,content_type='application/json',body=json.dumps({'data':detail}));return
                data=None
                if command=='app_boot':data={'user':None,'logged_in':False,'base':'https://example.test','strict_security':True}
                elif command=='playback_log_status':data={'enabled':False,'path':None,'error':None}
                elif command=='api_play':data={'id':args['id'],'ep_num':args['ep'],'duration':90,'title':TITLE,'video_url':f"{ORIGIN}/media/hls?p=test-ticket&r=manifest"}
                elif command in ('api_feed','api_category','api_posts','api_comments'):data={'items':[DETAIL] if command=='api_feed' and show_feed[0] else [],'pagination':{'page':1,'pages':1,'size':20,'total':0}}
                route.fulfill(status=200,content_type='application/json',body=json.dumps({'data':data}))

            def media(route):
                parsed=urlparse(route.request.url); query=parse_qs(parsed.query)
                if parsed.path.endswith('/hls'):
                    manifest=(MEDIA/'list.m3u8').read_text()
                    text='\n'.join(line if not line or line.startswith('#') else f"{ORIGIN}/media/seg?p=test-ticket&r={line}" for line in manifest.splitlines())+'\n'
                    route.fulfill(status=200,content_type='application/vnd.apple.mpegurl',body=text)
                else:
                    name=query['r'][0];assert name.startswith('seg') and name.endswith('.ts')
                    route.fulfill(status=200,content_type='video/mp2t',body=(MEDIA/name).read_bytes())

            page.route('**/api/invoke',api);page.route('**/media/**',media)
            page.goto(ORIGIN);page.wait_for_load_state('networkidle')
            assert not [item for item in commands if item[0]=='api_video'], 'Hidden history must not fetch details'
            page.get_by_role('button',name='我的',exact=True).click()
            page.get_by_role('button',name='观看历史',exact=True).last.click()
            expect(page.get_by_role('button',name=re.compile('继续观看.*123'))).to_be_visible()
            assert len(page.get_by_role('button',name=re.compile('继续观看')).all())==2, 'Failed metadata must not erase history'
            fail_details[0]=False
            page.get_by_role('button',name='重试加载资料',exact=True).click()
            expect(page.get_by_role('button',name=re.compile('继续观看 '+TITLE))).to_be_visible()
            page.get_by_role('button',name=re.compile('继续观看 '+TITLE)).click()
            wait_video(page,12)
            expect(page.get_by_role('button',name='查看博主信息',exact=True)).to_be_visible()
            page.get_by_role('button',name='查看博主信息',exact=True).click()
            expect(page.get_by_role('region',name='博主信息').get_by_text(AUTHOR,exact=True)).to_be_visible()
            page.get_by_role('button',name='选集',exact=True).last.click()
            page.get_by_role('button',name='第 3 集',exact=True).click()
            wait_video(page)
            assert any(command=='api_play' and args.get('ep')==3 for command,args in commands)
            # 保存最后五秒内的进度，然后验证刷新仍能续播。
            page.evaluate("document.querySelector('video').currentTime=8")
            page.wait_for_timeout(400)
            page.evaluate("window.dispatchEvent(new Event('pagehide'))")
            saved_progress=page.evaluate("JSON.parse(localStorage.getItem('hghub_app_v1')).history.find(item=>item.id===123)")
            assert saved_progress['ep']==3 and saved_progress['t']>=8
            fail_details[0]=True
            page.reload();page.wait_for_load_state('networkidle');wait_video(page)
            expect(page.get_by_role('button',name='查看博主信息',exact=True)).to_be_visible()
            page.get_by_role('button',name='选集',exact=True).last.click()
            expect(page.get_by_role('button',name='第 3 集',exact=True)).to_have_attribute('aria-pressed','true')
            page.get_by_role('button',name='第 3 集',exact=True).click()
            page.get_by_role('button',name='查看博主信息',exact=True).click()
            expect(page.get_by_role('region',name='博主信息').get_by_text(AUTHOR,exact=True)).to_be_visible()
            page.wait_for_timeout(400)  # 等待抽屉/页面过渡完成后检查布局。
            page.screenshot(path=str(output/('mobile-author.png' if mobile else 'desktop-author.png')))
            page.get_by_role('button',name='关闭',exact=True).last.click()
            fail_details[0]=False
            page.get_by_role('button',name='重试剧集信息',exact=True).click()
            expect(page.get_by_role('button',name='重试剧集信息',exact=True)).to_have_count(0)
            stored=page.evaluate("JSON.parse(localStorage.getItem('hghub_app_v1'))")
            assert any(item['id']==123 and item['ep']==3 for item in stored['history'])
            assert 'dummy-private-playback' not in json.dumps(stored) and 'dummy-private-key' not in json.dumps(stored)
            page.get_by_role('button',name='返回',exact=True).click()
            page.reload();page.wait_for_load_state('networkidle')
            expect(page.get_by_role('button',name=re.compile('继续观看 '+TITLE))).to_be_visible()
            assert len(page.get_by_role('button',name=re.compile('继续观看')).all())==2
            page.wait_for_timeout(400)  # 等待抽屉/页面过渡完成后检查布局。
            page.screenshot(path=str(output/('mobile-history.png' if mobile else 'desktop-history.png')))
            if not mobile:
                # 慢资料请求期间全局状态重渲染，不应丢弃完成的响应。
                hold_details[0]=True;show_feed[0]=True
                page.evaluate("sessionStorage.removeItem('hghub_view_v1')")
                page.reload();wait_video(page)
                initial_requests=len(pending_details)
                assert 1<=initial_requests<=2  # 开发入口的 StrictMode 会模拟一次重新挂载。
                page.get_by_role('button',name='切换外观',exact=True).click()
                page.wait_for_timeout(200)
                assert len(pending_details)==initial_requests, 'Unrelated renders must not restart details request'
                for route,args in pending_details:
                    route.fulfill(status=200,content_type='application/json',body=json.dumps({'data':{**DETAIL,'title':TITLE+'已更新'}}))
                pending_details.clear()
                expect(page.locator('.desktop-video-meta').get_by_text(TITLE+'已更新',exact=True)).to_be_visible()
            page.get_by_role('button',name='我的',exact=True).click()
            page.get_by_role('button',name='观看历史',exact=True).last.click()
            page.get_by_role('button',name='清空观看历史',exact=True).click()
            page.reload();page.wait_for_load_state('networkidle')
            expect(page.get_by_text('还没有观看记录',exact=True)).to_be_visible()
            assert page.evaluate("JSON.parse(localStorage.getItem('hghub_app_v1')).history.length")==0
            assert not errors, errors
            reports.append({'mobile':mobile,'history_survives_metadata_failure':True,'author_and_episodes_survive_reload':True,'episode_restored':3,'playback_secrets_not_persisted':True,'page_errors':errors})
            context.close()
        browser.close()
    print(json.dumps(reports,ensure_ascii=False))


if __name__=='__main__':main()
