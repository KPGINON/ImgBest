# ImgBest AI 商品图定制站

这是一个面向收费产品雏形的网站。页面围绕电商定制产品图生成，Node.js 后端提供 API、内存任务暂存、上传图片落盘，并预留 ComfyUI 或其他生图服务接口。

## 已内置的付费功能感

- 品牌风格包：按轻奢、爆款、通勤、目录统一等方向组织 prompt。
- 场景模板：快速切换街拍、棚拍、精品店等电商常用出图场景。
- 批量变体：一次任务生成多张 prompt 变体，用于首图、详情页和广告测试。
- Prompt 成熟度：根据输入完整度和关键词给出实时评分。
- 增值模块：卖点提炼、渠道化 prompt、商品一致性锁定、手部肩带优化、纹理清晰度。
- 任务历史：保存最近生成记录，方便复用和追踪。
- 任务导出：导出 JSON payload，便于交给后端队列或 ComfyUI 工作流。
- 一键换包：上传包的正面、左 45 度、右 45 度、顶部视图和模特图，生成模特自然拿着指定包的图片。

## 文件

- `index.html`: 页面结构和输入表单
- `styles.css`: 响应式视觉样式
- `app.js`: prompt 组装、API 调用、历史和导出
- `server.js`: Node.js 后端，提供静态文件、API、内存账户/积分/任务暂存和上传存储
- `package.json`: 启动和检查脚本
- `uploads/`: 运行后自动创建的上传素材目录
- `assets/hero-bag-model.png`: 项目内主视觉素材

## 本地运行

```bash
npm start
```

然后打开：

```text
http://127.0.0.1:3000
```

如果要配合 Nginx 代理，固定 Node 端口为服务器本机 `3000`：

```bash
PORT=3000 npm start
```

可用接口：

- `POST /api/generate-image`: 创建商品图或一键换包任务
- `GET /api/tasks`: 查看最近任务
- `GET /api/tasks/{id}`: 查看单个任务和上传素材
- `GET /api/health`: 健康检查

## 存储

当前后端不依赖数据库，账户、积分、支付状态、任务历史和邀请记录都暂存在内存里。重启服务后这些数据会清空。

上传图片仍会保存到 `uploads/`，任务记录只在当前 Node 进程内保存文件引用。

后续接入正式数据库时，建议把 `server.js` 里的 `store`、账户查询、积分流水、支付记录、任务和素材记录替换成数据库读写即可，API 路由可以继续沿用。

## 接入 ComfyUI

在 `app.js` 中设置：

```js
const COMFYUI_ENDPOINT = "/api/generate-image";
```

建议不要让浏览器直接访问 ComfyUI。生产环境继续使用当前 Node 后端作为代理，在 `server.js` 的 `handleGenerateImage` 中把已保存的图片 URL 或磁盘路径传给 ComfyUI 工作流，再把真实生成图 URL 写回任务记录。

接口建议返回：

```json
{
  "id": "task-123",
  "imageUrl": "https://cdn.example.com/result.png",
  "variants": [
    {
      "id": "v1",
      "imageUrl": "https://cdn.example.com/result-v1.png",
      "prompt": "variant prompt"
    }
  ]
}
```

## 一键换包工作流

前端会构造 `model-bag-replacement` payload，包含：

- `bagViews.front`: 包正面
- `bagViews.left45`: 左 45 度
- `bagViews.right45`: 右 45 度
- `bagViews.top`: 顶部
- `modelImage`: 模特图
- `holdingStyle`: 手提、肩背、斜挎、挽臂
- `blendStrength`: 保包型或自然融合优先

生产环境建议把图片先上传到对象存储，再把 URL 传给 ComfyUI 后端，不建议长期使用 base64 直接塞进浏览器请求。

## Nginx 部署到 img.zzggo.fun

项目已提供配置：

- `deploy/nginx/img.zzggo.fun.conf`: Nginx 反向代理配置
- `deploy/systemd/imgbest.service`: systemd 服务模板

假设项目部署在 `/var/www/imgbest`，Node 服务监听 `127.0.0.1:3000`：

```bash
sudo mkdir -p /var/www/imgbest
sudo cp -r . /var/www/imgbest
cd /var/www/imgbest
npm run check
```

安装 systemd 服务：

```bash
sudo cp deploy/systemd/imgbest.service /etc/systemd/system/imgbest.service
sudo systemctl daemon-reload
sudo systemctl enable --now imgbest
sudo systemctl status imgbest
```

安装 Nginx 配置：

```bash
sudo cp deploy/nginx/img.zzggo.fun.conf /etc/nginx/sites-available/img.zzggo.fun.conf
sudo ln -s /etc/nginx/sites-available/img.zzggo.fun.conf /etc/nginx/sites-enabled/img.zzggo.fun.conf
sudo nginx -t
sudo systemctl reload nginx
```

DNS 需要把 `img.zzggo.fun` 的 A 记录指向服务器公网 IP。HTTPS 可以用 certbot：

```bash
sudo certbot --nginx -d img.zzggo.fun
```
