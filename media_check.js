/**
 * 流媒体 & AI 服务解锁检测脚本
 * 适用于 Surge Panel，点击即可检测当前节点解锁状态
 * 
 * 检测服务：Netflix, YouTube Premium, Disney+, Spotify,
 *           ChatGPT, Claude, TikTok, Bilibili港澳台,
 *           HBO Max, Amazon Prime Video, DAZN, TVB
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const REQUEST_HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'en',
}

// 超时时间（毫秒）
const TIMEOUT = 5000

// ==================== 工具函数 ====================

/**
 * 超时 Promise
 */
function timeout(ms = TIMEOUT) {
  return new Promise((_, reject) => {
    setTimeout(() => reject('Timeout'), ms)
  })
}

/**
 * 带超时的 HTTP GET 请求
 */
function httpGet(option) {
  return Promise.race([
    new Promise((resolve, reject) => {
      $httpClient.get(option, (error, response, data) => {
        if (error) {
          reject(error)
          return
        }
        resolve({ response, data })
      })
    }),
    timeout()
  ])
}

/**
 * 带超时的 HTTP POST 请求
 */
function httpPost(option) {
  return Promise.race([
    new Promise((resolve, reject) => {
      $httpClient.post(option, (error, response, data) => {
        if (error) {
          reject(error)
          return
        }
        resolve({ response, data })
      })
    }),
    timeout()
  ])
}

// ==================== 检测函数 ====================

/**
 * Netflix 检测
 * 200=全解锁(从 x-originating-url 提取地区), 403=不可用
 */
async function checkNetflix() {
  try {
    const { response } = await httpGet({
      url: 'https://www.netflix.com/title/81280792',
      headers: REQUEST_HEADERS,
    })

    if (response.status === 403) {
      // 尝试自制剧
      const { response: res2 } = await httpGet({
        url: 'https://www.netflix.com/title/80018499',
        headers: REQUEST_HEADERS,
      })
      if (res2.status === 200) {
        let url = res2.headers['x-originating-url'] || ''
        let region = extractNetflixRegion(url)
        return '仅自制 ' + region
      }
      return '✗'
    }

    if (response.status === 200) {
      let url = response.headers['x-originating-url'] || ''
      let region = extractNetflixRegion(url)
      return '✓ ' + region
    }

    return '✗'
  } catch (e) {
    return e === 'Timeout' ? '⚠️ 超时' : '✗'
  }
}

function extractNetflixRegion(url) {
  try {
    let parts = url.split('/')
    let region = parts[3] || 'US'
    region = region.split('-')[0]
    if (region === 'title') region = 'US'
    return region.toUpperCase()
  } catch {
    return 'US'
  }
}

/**
 * YouTube Premium 检测
 */
async function checkYouTube() {
  try {
    const { response, data } = await httpGet({
      url: 'https://www.youtube.com/premium',
      headers: REQUEST_HEADERS,
    })

    if (response.status !== 200) return '✗'

    if (data.indexOf('Premium is not available in your country') !== -1) {
      return '✗'
    }

    let re = /"countryCode":"(.*?)"/gm
    let result = re.exec(data)
    if (result && result.length === 2) {
      return '✓ ' + result[1].toUpperCase()
    } else if (data.indexOf('www.google.cn') !== -1) {
      return '✓ CN'
    }
    return '✓ US'
  } catch (e) {
    return e === 'Timeout' ? '⚠️ 超时' : '✗'
  }
}

/**
 * Disney+ 检测
 */
async function checkDisney() {
  try {
    // 先检测主页是否可访问
    const { response: homeRes, data: homeData } = await httpGet({
      url: 'https://www.disneyplus.com/',
      headers: { 'Accept-Language': 'en', 'User-Agent': UA },
    })

    if (homeRes.status !== 200 || 
        homeData.indexOf('Sorry, Disney+ is not available in your region.') !== -1) {
      return '✗'
    }

    // GraphQL 获取位置信息
    const { response, data } = await httpPost({
      url: 'https://disney.api.edge.bamgrid.com/graph/v1/device/graphql',
      headers: {
        'Accept-Language': 'en',
        'Authorization': 'ZGlzbmV5JmJyb3dzZXImMS4wLjA.Cu56AgSfBTDag5NiRA81oLHkDZfu5L3CKadnefEAY84',
        'Content-Type': 'application/json',
        'User-Agent': UA,
      },
      body: JSON.stringify({
        query: 'mutation registerDevice($input: RegisterDeviceInput!) { registerDevice(registerDevice: $input) { grant { grantType assertion } } }',
        variables: {
          input: {
            applicationRuntime: 'chrome',
            attributes: {
              browserName: 'chrome',
              browserVersion: '120.0.0',
              manufacturer: 'apple',
              model: null,
              operatingSystem: 'macintosh',
              operatingSystemVersion: '10.15.7',
              osDeviceIds: [],
            },
            deviceFamily: 'browser',
            deviceLanguage: 'en',
            deviceProfile: 'macosx',
          },
        },
      }),
    })

    if (response.status !== 200) return '✗'

    let json = JSON.parse(data)
    if (json?.errors) return '✗'

    let sdk = json?.extensions?.sdk
    if (sdk) {
      let countryCode = sdk.session?.location?.countryCode || ''
      let inSupported = sdk.session?.inSupportedLocation
      if (inSupported === false || inSupported === 'false') {
        return '即将登陆 ' + countryCode.toUpperCase()
      }
      return '✓ ' + countryCode.toUpperCase()
    }

    return '✓'
  } catch (e) {
    return e === 'Timeout' ? '⚠️ 超时' : '✗'
  }
}

/**
 * Spotify 检测
 */
async function checkSpotify() {
  try {
    const { data } = await httpGet({
      url: 'https://spclient.wg.spotify.com/signup/public/v1/account',
      headers: { 'Accept-Language': 'en', 'User-Agent': UA },
    })

    let json = JSON.parse(data)
    let country = json.country || ''
    if (country) {
      return '✓ ' + country.toUpperCase()
    }
    return '✗'
  } catch (e) {
    return e === 'Timeout' ? '⚠️ 超时' : '✗'
  }
}

/**
 * ChatGPT 检测
 */
async function checkChatGPT() {
  try {
    // 使用 Cloudflare trace 检测
    const { data } = await httpGet({
      url: 'https://chat.openai.com/cdn-cgi/trace',
      headers: { 'User-Agent': UA },
    })

    // 解析 trace 数据
    let lines = data.split('\n')
    let loc = ''
    for (let line of lines) {
      if (line.startsWith('loc=')) {
        loc = line.split('=')[1]
        break
      }
    }

    // 检测 iOS API 是否可用
    const { response } = await httpGet({
      url: 'https://ios.chat.openai.com/public-api/mobile/server_status/v1',
      headers: { 'User-Agent': UA },
    })

    if (response.status === 200) {
      return loc ? '✓ ' + loc : '✓'
    }
    return '✗'
  } catch (e) {
    return e === 'Timeout' ? '⚠️ 超时' : '✗'
  }
}

/**
 * Claude/Anthropic 检测
 */
async function checkClaude() {
  try {
    const { response } = await httpGet({
      url: 'https://claude.ai/login',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
      },
    })

    // 如果能正常访问登录页面则说明可用
    if (response.status === 200 || response.status === 302) {
      return '✓'
    }
    // 403 表示地区受限
    if (response.status === 403) {
      return '✗'
    }
    return '✗'
  } catch (e) {
    return e === 'Timeout' ? '⚠️ 超时' : '✗'
  }
}

/**
 * TikTok 检测
 */
async function checkTikTok() {
  try {
    const { response, data } = await httpGet({
      url: 'https://www.tiktok.com/',
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'en',
      },
    })

    if (response.status !== 200) return '✗'

    // 从页面内容中提取地区信息
    let regionMatch = data.match(/"region":"(\w{2})"/)
    if (regionMatch) {
      return '✓ ' + regionMatch[1].toUpperCase()
    }

    // 尝试从 URL 重定向中判断
    let urlMatch = data.match(/region=(\w{2})/)
    if (urlMatch) {
      return '✓ ' + urlMatch[1].toUpperCase()
    }

    // 检测是否被封锁
    if (data.indexOf('tiktok') !== -1) {
      return '✓'
    }

    return '✗'
  } catch (e) {
    return e === 'Timeout' ? '⚠️ 超时' : '✗'
  }
}

/**
 * Bilibili 港澳台检测
 */
async function checkBilibili() {
  try {
    const { data } = await httpGet({
      url: 'https://api.bilibili.com/pgc/player/web/playurl?avid=18281381&cid=29892777&qn=0&type=&otype=json&ep_id=364558&fourk=1&fnval=16',
      headers: {
        'User-Agent': UA,
        'Referer': 'https://www.bilibili.com/',
      },
    })

    let json = JSON.parse(data)
    if (json.code === 0) {
      return '✓ 港澳台'
    }
    return '✗'
  } catch (e) {
    return e === 'Timeout' ? '⚠️ 超时' : '✗'
  }
}

/**
 * HBO Max (now Max) 检测
 */
async function checkHBO() {
  try {
    const { response, data } = await httpGet({
      url: 'https://www.max.com/',
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'en',
      },
    })

    if (response.status === 200) {
      // 检查是否有地区限制提示
      if (data.indexOf('not available') !== -1 || 
          data.indexOf('not yet available') !== -1) {
        return '✗'
      }
      return '✓'
    }

    // 403 表示地区不可用
    if (response.status === 403) return '✗'
    return '✗'
  } catch (e) {
    return e === 'Timeout' ? '⚠️ 超时' : '✗'
  }
}

/**
 * Amazon Prime Video 检测
 */
async function checkPrimeVideo() {
  try {
    const { response, data } = await httpGet({
      url: 'https://www.primevideo.com/',
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'en',
      },
    })

    if (response.status !== 200) return '✗'

    // 从页面中提取当前市场地区
    let regionMatch = data.match(/"currentTerritory":"(\w{2})"/)
    if (regionMatch) {
      return '✓ ' + regionMatch[1].toUpperCase()
    }

    // 尝试备用匹配
    let marketMatch = data.match(/"marketplace":"(\w{2})"/)
    if (marketMatch) {
      return '✓ ' + marketMatch[1].toUpperCase()
    }

    if (data.indexOf('primevideo') !== -1) {
      return '✓'
    }

    return '✗'
  } catch (e) {
    return e === 'Timeout' ? '⚠️ 超时' : '✗'
  }
}

/**
 * DAZN 检测
 */
async function checkDAZN() {
  try {
    const { response, data } = await httpGet({
      url: 'https://startup.core.indazn.com/misl/v5/Ede',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
      },
    })

    // DAZN 使用 Geo 检测
    if (response.status === 200) {
      return '✓'
    }

    // 尝试备用检测
    const { response: res2 } = await httpGet({
      url: 'https://www.dazn.com/',
      headers: { 'User-Agent': UA },
    })

    if (res2.status === 200) {
      return '✓'
    }
    return '✗'
  } catch (e) {
    return e === 'Timeout' ? '⚠️ 超时' : '✗'
  }
}

/**
 * TVB 检测
 */
async function checkTVB() {
  try {
    const { response, data } = await httpGet({
      url: 'https://www.mytvsuper.com/iptest.php',
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'en',
      },
    })

    if (response.status === 200) {
      // 检测返回内容判断是否在支持地区
      let json = JSON.parse(data)
      if (json.country === 'HK' || json.region === 'HK') {
        return '✓'
      }
      // 有些返回格式不同，只要能访问就尝试判断
      if (data.indexOf('HK') !== -1) {
        return '✓'
      }
      return '✗'
    }
    return '✗'
  } catch (e) {
    // TVB 可能返回非 JSON，尝试简单判断
    if (typeof e === 'string' && e === 'Timeout') return '⚠️ 超时'
    return '✗'
  }
}

// ==================== 主逻辑 ====================

;(async () => {
  let panel_result = {
    title: '流媒体解锁检测',
    content: '',
    icon: 'play.tv.fill',
    'icon-color': '#FF2D55',
  }

  try {
    // 并发执行所有检测
    const [
      netflix, youtube, disney, spotify,
      chatgpt, claude, tiktok, bilibili,
      hbo, prime, dazn, tvb
    ] = await Promise.all([
      checkNetflix(),
      checkYouTube(),
      checkDisney(),
      checkSpotify(),
      checkChatGPT(),
      checkClaude(),
      checkTikTok(),
      checkBilibili(),
      checkHBO(),
      checkPrimeVideo(),
      checkDAZN(),
      checkTVB(),
    ])

    // 格式化输出，每行两个服务用 | 分隔
    let lines = [
      `Netflix: ${netflix} | YouTube: ${youtube}`,
      `Disney+: ${disney} | Spotify: ${spotify}`,
      `ChatGPT: ${chatgpt} | Claude: ${claude}`,
      `TikTok: ${tiktok} | HBO: ${hbo}`,
      `Bilibili: ${bilibili} | Prime: ${prime}`,
      `DAZN: ${dazn} | TVB: ${tvb}`,
    ]

    panel_result.content = lines.join('\n')
  } catch (e) {
    panel_result.content = '检测失败: ' + (e.message || e)
  }

  $done(panel_result)
})()
