# 共用比赛球台换件后的认证资料采集的演练来源

这里提供独立来源的本地合成记录，与实际单位、个人和线上业务无关。

## 本地运行

使用 Node.js 22.23.4。只使用 Node.js 自带的运行库。

执行 `npm test` 检查合成来源的接口。执行 `npm start` 启动来源，默认监听 `127.0.0.1:4100`，可通过环境变量 `PORT` 调整端口。访问根路径可看到来源名和当前回放阶段。

## 接口资料

| GET 路由 | 来源约定 |
| --- | --- |
| `/source/equipment` | board、net、jig 均使用实物号。assembly 是现场固定后生成的装配号。start、stop 为本馆当地时间。 |
| `/source/inspection` | 校验覆盖对象以 subject 为准。只针对明确的装配号的记录才证明装配关系。blockRange 左闭右开。 |
| `/source/referee` | 赛事授权要求 required 所列全部认可证据。reserve 预留，use 表示已使用现场组合。 |

查询参数 `offset` 是从零开始的页偏移，`limit` 默认 3，取值 1 至 100。响应中的 `records` 含 `record` 来源记录键、`availableFrom` 首次出现的回放阶段、`kind` 记录类型、`payload` 业务字段。来源记录键与业务身份分别定义。`next` 为下一页偏移，末页为 `null`。回放阶段中的记录按到达顺序可查。

控制员通过 `POST /control?stage=2` 切换到第 2 阶段，服务会保留更早已可查的记录。每次换阶段后按根路径返回的 `stage` 确认切换成功。

handover 由器材组确认一套装配已交还。transfer 使用 stamp 标明同一次转台，desk 和 referee 是独立确认状态。reserve 只记录预留，use 仅证明裁判端的实际使用。

handover 表示器材组已交还指定装配，reserve 仅占用竞赛时段，transfer 的 desk 与 referee 是两处独立确认。只有两端对相同 stamp 确认后，目标装配可以给该暂停场次继续使用。
