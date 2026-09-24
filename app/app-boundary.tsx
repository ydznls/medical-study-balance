"use client";
import { Component,type ReactNode } from "react";
export default class AppBoundary extends Component<{children:ReactNode},{failed:boolean}>{
 state={failed:false};
 static getDerivedStateFromError(){return {failed:true}}
 render(){return this.state.failed?<main className="workspace"><h1>余量</h1><section className="panel"><h2>页面暂时没能显示</h2><p>已保存的记录仍在。请重新加载页面；未保存的输入可能需要重填。</p><button className="btn" onClick={()=>window.location.reload()}>重新加载</button></section></main>:this.props.children}
}
