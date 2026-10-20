bmcl-mirror
自己架的 Minecraft 资源镜像
Node 18 以上
零依赖

做了什么

把 Mojang 官方源和 Forge Fabric NeoForge Quilt Liteloader OptiFine 的地址映射到本地路径
启动器只需要把域名换成本机
返回的 json 里的下载地址会自动改写成自己的域名
客户端拿到 json 之后所有后续请求都会回到这台机器
另外实现了 BMCLAPI 的私有聚合接口
forge liteloader neoforge optifine 的列表和 302 下载
实测和 bmclapi2.bangbang93.com 逐条对比 26/26 一致

跑起来

node src/server.js

默认监听 0.0.0.0:8080
缓存目录 ./cache

环境变量

BMCL_PORT 端口 默认 8080
BMCL_HOST 监听地址 默认 0.0.0.0
BMCL_BASE_URL 对外地址 建议设置 例如 https://mirror.example.com
BMCL_CACHE_DIR 缓存目录 默认 ./cache
BMCL_CACHE_MAX_BYTES 缓存上限 默认 64G
BMCL_META_TTL json 缓存秒数 默认 300
BMCL_FILE_TTL 文件缓存秒数 默认 0 表示不过期
BMCL_MAX_DOWNLOADS 同时回源数 默认 8
BMCL_UPSTREAM_TIMEOUT 回源超时毫秒 默认 60000
BMCL_CORS 跨域头 默认 *
BMCL_USER_AGENT 回源 UA

BMCL_BASE_URL 不设的话会按请求的 Host 头推断
反向代理后面请设置它 或者传 X-Forwarded-Host 和 X-Forwarded-Proto

预热相关

BMCL_WARMUP 设为 0 关闭后台预热
BMCL_FORGE_WARM_BUDGET 单轮预热时间预算毫秒 默认 600000
BMCL_FORGE_WARM_TTL 预热刷新周期秒 默认 21600
BMCL_FORGE_WARM_CONCURRENCY 预热并发 默认 4
BMCL_FORGE_WARM_PAUSE 每条之间的间隔毫秒 默认 50

forge 的 build hash 需要逐条回源抓 sha1 上游没有现成数据库
所以加了后台预热 首次启动会在后台把所有 build 填满
预热期间正常请求不受影响 并发默认压得很低

BMCL_SPONSORS 赞助商列表 逗号分隔 用竖线分开名字和链接
例如 "张三|https://a.com,李四|https://b.com"

镜像路由

/mc/game/version_manifest.json
/mc/game/version_manifest_v2.json
/v1/packages/*
/v1/products/*
/v1/objects/*
/assets/*
/maven/*
/fabric-meta/*
/quilt-meta/*
/mirrors/authlib-injector/*
/forge/promotions_slim.json
/forge/maven-metadata.json

聚合接口

/forge/minecraft
/forge/minecraft/:mcversion
/forge/list/:limit
/forge/list/:offset/:limit
/forge/last
/forge/promos
/forge/download?mcversion=&version=&category=&format=
/forge/download/:build
/liteloader/list
/liteloader/list?mcversion=
/liteloader/download?version=
/neoforge/list/:mcversion
/neoforge/version/:version
/neoforge/version/:version/download/:file
/neoforge/meta/*
/optifine/versionList
/optifine/:mcversion
/optifine/:mcversion/:type/:patch
/java/list
/openbmclapi/sponsor

内置接口

GET / 路由总览
GET /healthz 健康检查
GET /_stats 命中统计和缓存占用
GET /_routes 路由表
GET /_origins 上游地址
GET /_purge?path=/xxx 清一个缓存

下载器

node bin/download.js --version 1.20.1 --out ./minecraft

会拉版本 json 客户端 jar 全部依赖库 资源索引 全部资源对象
每个文件都校验 sha1 和大小
已存在的跳过 失败重试三次

参数

--mirror 镜像地址 默认 http://127.0.0.1:8080
--version 版本号
--out 输出目录 默认 ./minecraft
--jobs 并发 默认 16
--skip-assets 跳过资源
--list 列出所有版本

测试

node test/run.js
镜像核心功能 33 项

node test/compat-diff.js
和真实 bmclapi2 逐条对比 26 项
需要先起一个实例在 127.0.0.1:18081

node test/check-comments.js
扫描所有 js 确认没有注释

部署

systemd 用 deploy/bmcl-mirror.service
docker 用 Dockerfile 和 docker-compose.yml
nginx 反代示例在 deploy/nginx.conf

已知限制

OptiFine 的列表来自 optifine.net 下载页 只能拿到当前在架的 226 条
bmclapi 有 501 条是因为它自己存档了历史版本
但那些历史版本在 optifine.net 上已经取不到 实测 bmclapi 自己也返回 404

forge promos 里 latest 和 recommended 这两类无 mcversion 前缀的条目拿不到
上游 promotions_slim.json 里没有对应数据

liteLoader 1.12.2 这类只给 mcversion 的请求真实站返回 404
本实现行为一致

缓存说明

json 每次请求都会重新改写成当前域名 所以同一个缓存能被多个域名共用
二进制文件按路径落盘 目录结构就是 url 路径本身
超过上限按最久未访问淘汰
索引存在 cache/.index.json 丢了会自动扫描目录重建
forge build 元数据单独存 cache/compat/forge-builds.json

免责

只做缓存转发 不改文件内容
文件版权归原站点