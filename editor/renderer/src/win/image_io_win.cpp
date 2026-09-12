// WIC implementation of the image seam. The file decoder is what
// media_loader.cpp used to do inline; the PNG writer is thumbnail.cpp's.

#include "image_io.h"

#include <windows.h>
#include <objbase.h>
#include <wincodec.h>
#include <wrl/client.h>

#pragma comment(lib, "windowscodecs.lib")

using Microsoft::WRL::ComPtr;

namespace {

std::wstring widenUtf8(const std::string& s) {
    int wlen = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
    std::wstring out((size_t)(wlen > 0 ? wlen - 1 : 0), L'\0');
    if (wlen > 1) MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, out.data(), wlen);
    return out;
}

bool convertFrame(IWICImagingFactory* factory, IWICBitmapDecoder* decoder,
                  std::vector<uint8_t>& rgba, uint32_t& width, uint32_t& height) {
    ComPtr<IWICBitmapFrameDecode> frame;
    if (FAILED(decoder->GetFrame(0, &frame))) return false;

    ComPtr<IWICFormatConverter> converter;
    if (FAILED(factory->CreateFormatConverter(&converter))) return false;
    if (FAILED(converter->Initialize(frame.Get(), GUID_WICPixelFormat32bppRGBA,
        WICBitmapDitherTypeNone, nullptr, 0.0, WICBitmapPaletteTypeCustom))) return false;

    UINT w = 0, h = 0;
    converter->GetSize(&w, &h);
    if (w == 0 || h == 0) return false;

    UINT rowPitch = w * 4;
    rgba.resize((size_t)rowPitch * h);
    if (FAILED(converter->CopyPixels(nullptr, rowPitch, (UINT)rgba.size(), rgba.data())))
        return false;
    width = w;
    height = h;
    return true;
}

} // namespace

bool decodeImageFileRGBA(const std::string& path, std::vector<uint8_t>& rgba,
                         uint32_t& width, uint32_t& height) {
    ComPtr<IWICImagingFactory> factory;
    if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
        IID_PPV_ARGS(&factory)))) return false;

    std::wstring wpath = widenUtf8(path);
    ComPtr<IWICBitmapDecoder> decoder;
    if (FAILED(factory->CreateDecoderFromFilename(wpath.c_str(), nullptr, GENERIC_READ,
        WICDecodeMetadataCacheOnDemand, &decoder))) return false;
    return convertFrame(factory.Get(), decoder.Get(), rgba, width, height);
}

bool decodeImageBytesRGBA(const uint8_t* data, size_t size, std::vector<uint8_t>& rgba,
                          uint32_t& width, uint32_t& height) {
    if (!data || size == 0) return false;
    ComPtr<IWICImagingFactory> factory;
    if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
        IID_PPV_ARGS(&factory)))) return false;

    ComPtr<IWICStream> stream;
    if (FAILED(factory->CreateStream(&stream))) return false;
    if (FAILED(stream->InitializeFromMemory(const_cast<BYTE*>(data), (DWORD)size))) return false;
    ComPtr<IWICBitmapDecoder> decoder;
    if (FAILED(factory->CreateDecoderFromStream(stream.Get(), nullptr,
        WICDecodeMetadataCacheOnDemand, &decoder))) return false;
    return convertFrame(factory.Get(), decoder.Get(), rgba, width, height);
}

bool writePngBGRA(const std::string& path, const std::vector<uint8_t>& bgra,
                  uint32_t w, uint32_t h) {
    ComPtr<IWICImagingFactory> factory;
    if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                                IID_PPV_ARGS(&factory)))) return false;

    std::wstring wpath = widenUtf8(path);

    ComPtr<IWICStream> stream;
    if (FAILED(factory->CreateStream(&stream))) return false;
    if (FAILED(stream->InitializeFromFilename(wpath.c_str(), GENERIC_WRITE))) return false;

    ComPtr<IWICBitmapEncoder> encoder;
    if (FAILED(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder))) return false;
    if (FAILED(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache))) return false;

    ComPtr<IWICBitmapFrameEncode> frame;
    ComPtr<IPropertyBag2> props;
    if (FAILED(encoder->CreateNewFrame(&frame, &props))) return false;
    if (FAILED(frame->Initialize(props.Get()))) return false;
    if (FAILED(frame->SetSize(w, h))) return false;
    WICPixelFormatGUID fmt = GUID_WICPixelFormat32bppBGRA;
    if (FAILED(frame->SetPixelFormat(&fmt))) return false;
    if (FAILED(frame->WritePixels(h, w * 4, (UINT)bgra.size(),
                                  const_cast<BYTE*>(bgra.data())))) return false;
    if (FAILED(frame->Commit())) return false;
    return SUCCEEDED(encoder->Commit());
}
