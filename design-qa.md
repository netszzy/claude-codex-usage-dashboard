**Findings**

- [P1] 横屏左侧栏占用可用宽度
  Location: `phone-display.css` 横屏大屏规则。
  Evidence: 用户提供的实机截图中，`Usage Watch` 在左侧纵向栏顶部、`LIVE` 在底部，形成大块无效留白。
  Impact: 四张额度卡片被压窄，`Antigravity` 状态发生视觉拥挤。
  Fix: 已移除横屏侧栏网格；标题与 `LIVE` 归回同一顶栏，卡片使用全宽网格。

- [P1] 单卡额度信息集中在底部，阅读节奏断裂
  Location: `phone-display.css` 的横屏卡片指标区。
  Evidence: 用户提供的实机截图中，卡片头部与第一条额度之间留有大段空白，5H/7D 信息都挤在底部。
  Impact: 横屏外接屏的首要信息不能在扫视时连续读取。
  Fix: 已将无分组卡片的 5H、7D 设为等高上下分区；分组卡片从标题下开始分布，保留全部配额组。

- [P2] 倒计时数字与“重置”标签同级，辨识度不足
  Location: `phone-display.js`、`phone-display.css` 的 `metric-reset`。
  Evidence: 用户请求将倒计时时间字体稍微增大。
  Impact: 使用者要更费力地判断下一次可用时间。
  Fix: 已将倒计时数字拆为 `metric-reset-time`，在横屏以 12px、加粗字重显示，保留较小的“重置”标签。

**Open Questions**

- 当前 iPhone 已连接到手机服务（本机端口显示活跃连接），但本轮没有可控制、可截图的 iPhone 浏览器通道；需要在实机刷新后以新截图做最终视觉比较。

**Implementation Checklist**

- [x] 取消横屏专用左侧栏。
- [x] 将 `Usage Watch` 与 `LIVE` 置于同一顶栏。
- [x] 重新分配 5H/7D 卡片内的纵向空间。
- [x] 提升倒计时数字层级。
- [x] 重启手机显示服务，使新 CSS/JS 生效。
- [ ] 用同一横屏 iPhone 视口捕获实现截图并与源图并排比较。

**Follow-up Polish**

- 若实机上仍有过长 Agent 名称，可根据实际机型宽度再微调横屏卡片最小宽度。

Source visual truth path: `F:/desktop/Documents/Tencent Files/3012541548/nt_qq/nt_data/Pic/2026-08/Ori/7f229dd46504916ec7285c24e16aab0f.png`

Implementation screenshot path: unavailable in this run; physical iPhone browser is connected but not capture-controlled.

Viewport: source image depicts iPhone landscape; exact browser CSS viewport is unavailable.

State: paired phone display, dynamic quota data, landscape.

Full-view comparison evidence: source image reviewed; revised implementation capture is blocked.

Focused region comparison: blocked because no implementation screenshot is available.

Comparison history:

1. Source review found the left-side header rail, unused vertical space, and low-priority countdown typography. The CSS and rendering structure were changed accordingly.

Final result: blocked
