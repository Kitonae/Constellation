export namespace main {
	
	export class RendererStatus {
	    screenId: string;
	    state: string;
	    fps: number;
	    error?: string;
	    pid: number;
	
	    static createFrom(source: any = {}) {
	        return new RendererStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.screenId = source["screenId"];
	        this.state = source["state"];
	        this.fps = source["fps"];
	        this.error = source["error"];
	        this.pid = source["pid"];
	    }
	}

}

